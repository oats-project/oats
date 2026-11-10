# Desktop CLI API

The JSON contract between the `oats` CLI and the OATS Desktop.

## Scope

The Desktop never imports kernel code. Its server runs a discovered `oats`
binary with `execFile` (absolute path, argv, no shell) and decodes the JSON it
prints, strictly. This page describes one current shape per command, as the
kernel emits it.

- **Versioning is by capability, never by version string.** The probe lists
  `features` and per-API integers. Gate every read and mutation on them; an
  absent feature means the kernel cannot do it.
- **A document carries its own integer** where one exists (`operationsApi`,
  `readinessApi`, `eventsApi`, …). Dispatch on the payload's integer.
- **The envelope is authoritative over this prose.** If a captured payload
  and this page disagree, this page is the bug.
- **Shapes are closed.** The Desktop decodes many documents with exact key
  sets, so a new key is a contract change and is announced here first.

Conventions: paths are absolute; a `commit` is a full 40-hex id; `integrity`
and `digest` are `sha256-<hex>`; times are ISO-8601 UTC; repository keys are
canonical (`github.com/<org>/<repo>`, or `local/<abs-path>`). Examples use
`/w` as the deployment and shorten ids and digests with `…`. Package versions
in example payloads are illustrative snapshots, not deployment pin advice;
see the [official catalog](official-catalog.md) for current pins.

## The probe

`oats version --json` prints one object (not an envelope):

```json
{"schemaVersion":1,"name":"@awebai/oats","version":"0.30.0","desktopApi":1,
 "harnesses":["pi","claude","codex"],"sessionBackends":["tmux"],"launchOptions":["yolo"],
 "remote":["spawn","retire","status","session","session-start","session-restart","launch-config","roster","harvest","schedule","session-upload","operations",
           "readiness","instance-events","instance-git","lifecycle-plans"],
 "features":["retire-home","session-start","session-restart","launch-config","schedule","schedule-host-caps","session-upload","operations","instance-git",
             "instance-git-remote","souls-declarations","lifecycle-plans","retire-retention","readiness","spawn-preview","instance-events",
             "instance-events-2","schedule-history","schedule-read-2","spawn-preview-2","spawn-idempotency","spawn-idempotency-2","spawn-apply-2",
             "workspace-v2","instance-modules","spawn-provider-payload","served-identity","packages-no-approval","spawn-name","settings-origins",
             "team-model-3","settings-declared","capabilities-private","layers-from","harness","package-souls","triggers","automations","desktop-facts","launch-preference",
             "preview-composed-from","observe-max-age","spawn-preview-max-age","launch-config-default","capability-show","capture-file",
             "workspace-identity","server-connect","capability-route","servers-per-workspace","operator-default-soul","waiting-on-you",
             "automation-descriptions","souls-capabilities","soul-composed-instructions","teams-conditional-default",
             "server-probe-features","worktree-event","trigger-sources","session-attach-detach-key",
             "lifecycle-kernel-codes","schedule-run-warnings","lifecycle-claim-stop","launch-prompt-dev-channel",
             "soul-launch","retire-plan-own-worktree","spawn-kernel-codes","soul-skills","roster-workspace-key","spawn-apply-max-age",
             "status-retire-state","session-inspect-size","session-inspect-running","deployments-list"],
 "automationsApi":1,"workspaceApi":2,"instanceGitApi":1,"spawnApplyApi":1,"soulsApi":2,"lifecycleApi":1,
 "readinessApi":2,"spawnPreviewApi":2,"eventsApi":2,"scheduleHistoryApi":3,"scheduleApi":2,"operationsApi":2,
 "capabilityShowApi":1,"sessionViewer":{"prefixScroll":true},"package":"@awebai/oats"}
```

- The Desktop accepts `desktopApi === 1` and a released `version` inside
  `ACCEPT_RANGE` (`packages/client/cli-locator.mjs`); a prerelease is never
  accepted. The real gate is the feature list; its minimum is
  `packages-no-approval`.
- `harnesses` is what `--harness` accepts; `sessionBackends` what `--backend`
  accepts: `["tmux"]` since 0.31.0, when Herdr was removed (`--backend herdr`
  is refused with `E_HERDR_REMOVED`). A host without the `harness` feature
  lists `runtimes` instead.
- `remote` is the routed surface: the commands `--server <id>` sends to a
  registered server, plus `roster`. The Desktop checks the execution host's
  probe before a routed mutation. From 0.31: `readiness`, `instance-events`,
  `instance-git` and `lifecycle-plans` name the
  [routed reads and plans](#routed-reads-and-plans).
- `name` is the probe's contract value: `@awebai/oats` under either npm name,
  and a reader refuses any other. `package` is the npm name this kernel was
  installed under, `@awebai/oats` or `@oats-project/oats`, and is absent from a
  kernel before the bridge.
- `sessionViewer` (feature `session-attach-prefix-scroll`) is a fact of
  this host, not of the binary: `prefixScroll` is `true` when a viewer
  without a detach key binds `C-b [` here, that is when the `tmux` on
  `PATH` is 3.3 or later (`tmuxForwardsBoundKey`, lib/session-viewer.mjs),
  and `false` with an older tmux or none. The kernel asks `tmux -V` afresh
  at every run and keeps no answer, so read it again after a tmux upgrade.
  The feature is in every kernel's list that has the field, whatever this
  host's tmux: gate on the feature, then read the field.
- `readerApi` (feature `warm-reader`) is the protocol of `oats reader
  --stdio`, which the reader's hello repeats. Start a reader only where the
  probe lists both the feature and `readerApi: 1`
  ([The warm reader](#the-warm-reader)).
- In text mode the command prints `@awebai/oats <version> (desktop API v1)`.

### Features

| Feature | What it enables | API number |
|---|---|---|
| `retire-home` | `oats retire <instance> --home <abs>` | |
| `session-start`, `session-restart` | `oats session start/restart --home` | |
| `launch-config` | `oats launch-config …`; the selection flags on start and restart | |
| `schedule` | `oats schedule …` | `scheduleApi: 2` |
| `schedule-host-caps` | both host-install cap options, their `default` / `none` reset semantics, and cap status reporting; no promise about a particular stored cap value | |
| `session-upload` | `oats session upload` (and the host's `session receive`) | |
| `operations` | `oats operation run`; `operations[]` in inspect | `operationsApi: 2` |
| `instance-git`, `instance-git-remote` | `oats instance git/diff`; the observation's `remote` | `instanceGitApi: 1` |
| `souls-declarations` | `souls[].declarations` in inspect | `soulsApi: 2` |
| `lifecycle-plans`, `retire-retention` | stop and retire plans and guarded applies; retire keeps a worktree | `lifecycleApi: 1` |
| `readiness` | `oats readiness` | `readinessApi: 2` |
| `spawn-preview`, `spawn-preview-2` | the no-write preview with a bound `decision` (gate on `-2`) | `spawnPreviewApi: 2` |
| `spawn-apply-2` | `--expect-decision` apply | `spawnApplyApi: 1` |
| `spawn-idempotency`, `spawn-idempotency-2` | `--idempotency-key`; recovery before placement (gate on `-2`) | `spawnApplyApi: 1` |
| `instance-events`, `instance-events-2` | the bounded events read (gate on `-2`) | `eventsApi: 2` |
| `schedule-history`, `schedule-read-2` | run history with identity and provenance (gate on `schedule-read-2`) | `scheduleHistoryApi: 3` |
| `workspace-v2` | `onboard`, `sync`, `package`, `workspace status`, `capabilities`, `souls` | `workspaceApi: 2` |
| `instance-modules` | `instance.json` `modules`/`providers`/`workspace`; module drift in status; preview `modules[]` | |
| `instance-upgrade` | `oats instance upgrade` plan/apply/undo for stopped local homes; optional `upgrade` hook; `modules.<cap>.previous`; `modules-upgraded` event; start/restart package `drift` | |
| `spawn-provider-payload` | `oats spawn … --provider <cap> <key>=<value>` | |
| `served-identity` | `decision.effective.providers`; the served `identity` in inspect and status | |
| `packages-no-approval` | no package approval anywhere | |
| `spawn-name` | `oats spawn --name <slug>` | |
| `settings-origins` | preview `settingsOrigins` | |
| `settings-declared` | `declares` on inspect capabilities and preview modules | |
| `capabilities-private` | `private` on `oats capabilities` rows | |
| `layers-from` | `layers.<slot>.from` in inspect | |
| `team-model-3` | every team field; `oats teams`, `oats soul teams` (0.38.0; replaces `team-model-2`) | `teamsApi: 2`, `soulTeamsApi: 2` (payload only) |
| `harness` | the harness names ([Harness input spellings](#the-harness-rename-feature-harness-oats-0270)) | |
| `package-souls` | package soul rows, `qualifiedName`, `packages[].souls` | |
| `triggers` | `oats trigger …` | `triggerApi: 1` (payload only) |
| `automations` | workspace triggers and schedules; `oats automations refresh` | `automationsApi: 1` |
| `desktop-facts` | the facts under [Desktop facts](#desktop-facts-feature-desktop-facts-oats-0290) | |
| `launch-preference` | soul and local launch preferences; `launch`, `launchCurrent`, `launchFrom`; `--reselect-launch`; `key` on soul and agent rows ([Launch preferences](#soul-launch-preferences-feature-launch-preference-oats-0300)) | |
| `preview-composed-from` | `composedFrom` on preview `modules[]` ([Composition](#the-preview)) | |
| `observe-max-age` | `--max-age <s>` on the read verbs and their `observation` block ([Observation reuse](#observation-reuse-feature-observe-max-age-oats-0311)) | |
| `spawn-preview-max-age` | `--max-age <s>` on `spawn --preview` and its `observation` block ([Observation reuse](#observation-reuse-feature-observe-max-age-oats-0311), [The preview](#the-preview)) | |
| `capability-show` | `oats capabilities show <name>` and its `--file` form, OATS 0.34.0 ([`oats capabilities show`](#oats-capabilities-show)) | `capabilityShowApi: 1` |
| `capture-file` | `oats capture --file <path> --format cc\|pi\|codex --home <instance home> [--json]`: one session file captured as `--home` capture would, with a receipt bound to its bytes, OATS 0.35.0 (the capture USAGE and packages/record/README.md) | |
| `workspace-identity` | the deployment's workspace identity on `oats status --json` `workspace` (`key`, `ref`, `keyFrom`, `standalone`, `defaultTeam`, `teams`, `teamsFrom`) and each `oats server roster --json` group's relayed `workspace`, OATS 0.36.0 ([Workspace identity](#workspace-identity-feature-workspace-identity-oats-0360)) | |
| `servers-per-workspace` | `workspaceKey` on registrations and `oats server list --json` rows; `oats server list --workspace-ref <ref>` and its `unknownWorkspace`; `workspaceKey` on `oats server check --json`, OATS 0.39.0 ([Servers per workspace](#servers-per-workspace)) | |
| `server-connect` | `oats server connect`; `oats onboard --check`; `workspaceReadable` on `oats server check --json`, OATS 0.39.0 ([`oats server connect`](#oats-server-connect)) | |
| `capability-route` | `oats <namespace> <command> … --server <id>` runs the capability command on the server, OATS 0.39.0 ([Capability commands on a server](#capability-commands-on-a-server)) | |
| `operator-default-soul` | a capability command from a deployment without `--soul` resolves as the first soul that provides its namespace, using its settings and teams (named on stderr); none is `E_BAD_ARGS`, OATS 0.39.0 ([capabilities.md](capabilities.md)) | |
| `waiting-on-you` | the `waiting` event kind and the session boundary rule; `oats instance waiting` and `oats instance attention`; `waitingOnYou` (with `message`) on `oats status --json` instance rows, on `oats session inspect --json` and in the events read, OATS 0.40.0 ([Waiting on you](#waiting-on-you)) | `eventsApi: 2` |
| `automation-descriptions` | a `description` on every trigger and schedule row, local or workspace, by one rule; `oats schedule update <id> --description=<text>` (the description only) and `oats trigger update <id> --description=<text>`; `--description=<text>` on `schedule add` and `trigger add`, OATS 0.43.0 ([Shared row fields](#automations-shared-rows)) | |
| `souls-capabilities` | `capabilities` on `oats souls --json` rows: the capabilities each soul composes, keyed like `oats capabilities` rows, with `from`, OATS 0.45.0 ([`oats capabilities` and `oats souls`](#oats-capabilities---dir---json--capabilitiesapi-1--oats-souls---dir---json--soulsapi-1)) | |
| `soul-composed-instructions` | `oats inspect --soul <soul> --instructions` and its `souls[].composedInstructions`: the AGENTS.md a spawn of the soul here would write, with the soul body and each composed block as ranges, OATS 0.46.0 ([`oats inspect`](#oats-inspect---home-----soul----dir----json--operationsapi-2)) | |
| `soul-skills` | `oats inspect --soul <soul> --skills` and its `souls[].skills`: the soul's own skills, the ones a spawn of it copies, with each file's text ([`oats inspect`](#oats-inspect---home-----soul----dir----json--operationsapi-2)) | |
| `soul-composed-skills` | `oats inspect --soul <soul> --composed-skills` and its `souls[].composedSkills`: every skill a spawn of the soul gives its instance, its own and its capabilities', each with its `source` and each file's text ([`oats inspect`](#oats-inspect---home-----soul----dir----json--operationsapi-2)). The same kernels name each capability skill of `spawn --preview`'s `skills[]` as the spawn does ([The preview](#the-preview)) | |
| `spawn-suggest-name` | `oats spawn <soul> --preview --suggest-name`: the preview also chooses the name, from the task, through the soul's own harness, and says how in `naming` ([The suggested name](#the-suggested-name-feature-spawn-suggest-name)). Suggested names work on claude and pi; codex is numbered (`unsupported-harness`). Routed, the host needs the feature | |
| `teams-conditional-default` | `oats teams default <label> --if-absent \| --expect <label>` and `E_TEAM_DEFAULT_MISMATCH`; `oats teams add … --no-default` and its `reused` answer; `E_TEAM_EXISTS` `observed`; unknown flags on `oats teams` refused, OATS 0.48.0 ([`oats teams`](#oats-teams)). A kernel without it ignores the flags: `--if-absent` there is an unconditional set, so check the feature before passing them | |
| `worktree-event` | the `worktree` hook event; `oats worktree add\|remove` ([`oats worktree`](#oats-worktree)); `worktreeHooks` on `spawn --preview` and on the spawn result and `spawned` event; `spawnInProgress` on `oats status --json` instance rows; the `worktree-added` event kind; `E_INTERRUPTED` and `E_WORKTREE_DIRTY`, OATS 0.49.0 | |
| `trigger-sources` | capability-declared trigger sources: `on.source: "<capability>:<source>"` triggers and their added row keys, `oats trigger poll`, `--run-source` on `trigger test` and `trigger poll` (`E_TRIGGER_SOURCE_RUN` without it), `E_TRIGGER_SOURCE`, `E_TRIGGER_POLL` `details.cause`, and `triggerSources`/`triggerSourceProblems` on `oats capabilities show`, OATS 0.50.0 ([`oats trigger`](#oats-trigger)) | `triggerApi: 1` (payload only) |
| `server-probe-features` | `features` on `oats status --json` (this kernel's own list, as `version --json` answers it), and each `oats server roster --json` group's `probe.features`: the host's list, relayed from that status answer after validation, `null` when unknown, OATS 0.49.0 ([The remote roster](#the-remote-roster-oats-server-roster---json)) | |
| `session-inspect-size` | `size: { cols, rows }` in cells on `session inspect --json` when `present` is true; absent otherwise. Remote inspect relays the execution host's size ([Inspect, input and attach](execution-targets.md#inspect-input-and-attach)) | |
| `session-inspect-running` | `running` on every successful `session inspect --json` result: `true` exactly when `oats status --json` reads the same observation as `running: true` (a live non-shell process in the agent pane, a harness behind a wrapper shell included), `false` for a fallback shell, an absent or dead pane, a missing home and a home that never launched. It is endpoint activity, not health, readiness, busy or idle, the executable's identity or a consumed wake. A failed observation stays an error, never `false`, a gone tmux server included (status reads that row `running: false`; inspect answers `E_SESSION_UNAVAILABLE`), and so does a process scan that cannot establish a fallback shell ([#1641](https://github.com/awebai/oats/issues/1641): status reads it `null`); `state` and its enum are unchanged. `E_RUNTIME_AUTHORITY_MISMATCH` carries `details.fields`, the differing fields among `launched`, `tmux.session`, `tmux.window`, `tmux.socket`, never their values. Remote inspect relays the execution host's answer; a host without the feature omits `running`, and nothing adds it ([Inspect, input and attach](execution-targets.md#inspect-input-and-attach)) | |
| `session-attach-detach-key` | `oats session attach … --detach-key <key>`, local and `--server`: the one key that detaches that viewer, and exit status 20 when it did, OATS 0.51.0 ([execution-targets.md](execution-targets.md#inspect-input-and-attach)). Gate on the probe and never try: a kernel without it ignores the flag and opens a viewer with no exit. A routed attach refuses a host without it (`E_REMOTE_INCOMPATIBLE`, `details: {"feature":"session-attach-detach-key"}`) | |
| `session-attach-no-status-line` | `oats session attach … --no-status-line`, local and `--server`: a viewer without a detach key, without its status line (`Shift+PgUp or C-b [ to scroll back`), for a caller that shows the scroll keys itself ([execution-targets.md](execution-targets.md#inspect-input-and-attach)). Gate on the probe: a kernel without it ignores the flag and shows the line. A routed attach sends it to any host, with no probe of its own | |
| `session-attach-prefix-scroll` | `sessionViewer: {prefixScroll}` on `oats version --json` and `oats status --json`, and `probe.sessionViewer` on each `oats server roster --json` group: whether that host's viewer without a detach key binds `C-b [` (tmux 3.3 and later), read afresh per host at each run. A kernel with the feature has the viewer's `Shift+PgUp` binding; one without it may not, so don't name the viewer's scroll keys for its tabs ([execution-targets.md](execution-targets.md#inspect-input-and-attach)) | |
| `lifecycle-kernel-codes` | `oats retire`, `oats instance stop`, `oats session …` and `oats worktree add\|remove` answer kernel codes only (`^E_[A-Z0-9_]+$`), in `error.code` and in the codes inside their results, with one exception: a document with an unsafe mapping key or value is refused under its own name, `unsafe-config-key` or `unsafe-config-value`, by these commands as by every other; `error.details.cause` on an error that has a code which is not a kernel code (`{code, syscall}`) and on a defect of the kernel (`{name}`), and none on a refusal that has no code, which is answered with the command's general code and its message alone ([The envelope](#kernel-codes)); `error.details.reached` on every error of a retire apply once the retire of the home has begun, and its absence before that ([`error.details.reached`](#retire-reached)), OATS 0.52.0. Gate on the probe: a kernel without it can answer one of these commands with a system code (`ENOENT`, `EACCES`), and an absent `reached` there says nothing | |
| `schedule-run-warnings` | a schedule run's record (`lastRun`, `recentRuns[]`) and a trigger fire's record and `lastRun` carry `warnings?`, the launch answer's warnings, when it had some; OATS 0.52.0 ([schedules and triggers](#schedules-and-triggers)) | |
| `lifecycle-claim-stop` | `oats instance stop --apply` holds the claim of every target (the file one retire of a home at a time is ordered by), so a stop is refused beside a retire in flight (`E_INSTANCE_RETIRING`) or another stop (`E_LIFECYCLE_BUSY`), a retire beside a stop (`E_LIFECYCLE_BUSY`), and `oats worktree add` beside a retire (`E_INSTANCE_RETIRING`), each before any effect ([Commands that meet on one home](#lifecycle-pairs)); a stop that was killed refuses nothing afterwards, and `<home>/.oats-stop-pending.json` is no longer written or read: a client's own handling of a stale stop marker is not needed for a kernel that lists this; `error.details.action` (the holder's verb) on those refusals, and `error.details.holder` on every `E_LIFECYCLE_BUSY` ([`details.holder`](#busy-holder)); the codes a stop and a retire answer only before any effect, as one list ([the list](#before-effect-codes)), with two retire answers that came after an effect given codes outside it (`E_WORK_PRESERVATION_FAILED`, `E_RUNTIME_QUIESCE_FAILED`), OATS 0.52.0. Gate on the probe; routed with `--server`, on the host's list | |
| `launch-prompt-dev-channel` | the kernel confirms Claude's development-channel prompt whenever it launches Claude with `--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`, with no consent setting; `launchPromptAnswers` gone from previews; `consentSource` gone from `launch-prompt` events, which carry `claudeVersion`, `claudeVersionSource` and, on a miss, `differed`; `launchPrompts.status: "not-engaged"` and `"flag-ignored"`; `launchPrompts` in a launched spawn's answer; the `launch-prompt` readiness warning, OATS 0.52.0 ([Launch prompt results](#launch-prompt-results)) | |
| `soul-launch` | `oats soul launch set\|remove`, the writer of `oats-local.yaml` `souls.launch`, and `E_LAUNCH_PREFERENCE_UNKNOWN`, OATS 0.53.0 ([`oats soul launch`](#oats-soul-launch)). Gate on the probe: a kernel without it answers `E_USAGE` | `soulLaunchApi: 1` (payload only) |
| `retire-plan-own-worktree` | a retire plan carries `facts.ownWorktree`, a boolean: whether `work/` is the instance's own work tree, the one the retire retains or removes; in `oats retire --plan` and in the fresh plan (`details.plan`) of `E_PLAN_STALE` and `E_CHILDREN_RUNNING`; a stop plan does not carry it; OATS 0.53.0 ([the retire plan](#retire)) | |
| `spawn-kernel-codes` | `oats spawn`, apply and `--preview`, answers the kernel's own code, as raised, whatever stage of the spawn raised it; `E_SPAWN_FAILED` is for an error with no kernel code (with `details.cause`, as the lifecycle commands' general codes have it). A code says nothing about how far the spawn got: `details.unconfirmed` does. Details are those each code had before; OATS 0.56.0 ([spawn errors](#spawn-errors)). A kernel without it answers `E_SPAWN_FAILED` for most kernel codes its kernel stage raised: there, that code may hide one | |
| `roster-workspace-key` | `oats server roster --workspace-key <key>`, repeatable: only the groups that can belong to one of the given workspaces are probed and returned (registered for one of them, registered with no known `workspaceKey`, or saved routes only); the answer's shape is unchanged, OATS 0.56.0 ([The remote roster](#roster-workspace-key)). Gate on the probe: a kernel without it ignores the flag and probes and answers every group | |
| `spawn-apply-max-age` | `--max-age <s>` on a spawn apply bound by `--expect-decision <revision>`: the apply reuses member heads as the preview does, its decision fence unchanged, and its answer carries no `observation` block, OATS 0.58.0 ([Apply](#apply)). Gate on the probe: a kernel without it refuses the flag on an apply (`E_BAD_ARGS`) | |
| `instance-color` | `oats instance color <instance> (<color> \| --clear)`, local and `--server` ([An instance's colour](#an-instances-colour-oats-instance-color)); `color` on `oats status --json` instance rows, on `oats server roster --json` rows and on `oats inspect --home` `instance` (`null` for none). Gate on the probe, locally or in the host's `probe.features`: an older kernel's rows have no `color` | `instanceColorApi: 1` (payload only) |
| `instance-same-work` | `oats instance same-work <instance> on\|off` and `oats spawn … --same-work`, local and `--server` ([Same work as the parent](#same-work-as-the-parent-oats-instance-same-work)); `sameWork: true` on `oats status --json` instance rows and on `oats server roster --json` rows while the instance's flag is bound to its current `parentInstance`, the key absent otherwise ([`sameWork`](#row-same-work)). Gate on the probe, locally or in the host's `probe.features`: an older kernel's rows never carry `sameWork`, and it refuses the flag and the verb (`E_BAD_ARGS`) | |
| `deployments-list` | `oats deployments [list]\|add\|remove\|import --json`, this computer's list of its deployments (`~/.oats/config/deployments.json`); `listed` on `oats onboard --json`; a kernel command run in an unlisted deployment lists it ([This computer's deployments](#this-computers-deployments-oats-deployments)). Gate on the probe: there is no fallback scan | `deploymentsApi: 1` |
| `status-retire-state` | `retire` on `oats status --json` instance rows and on remote roster rows: whether a retire of the home is running, cannot be told, failed or was interrupted, read only from the files beside the home, OATS 0.59.0 ([`retire`](#row-retire)). `retirePending` is unchanged. Gate on the probe: a kernel without it never carries the field, so its absence there says nothing | |
| `instance-suggest-name` | `oats instance suggest-name --soul <soul> (--task <t> \| --task-file <f>) [--harness claude\|pi] [--model <m>] [--launch-config <n>] --json`: the name a `--suggest-name` spawn of `<soul>` would get, chosen on this machine for a spawn that may land on another, not made unique ([A name for a spawn elsewhere](#a-name-for-a-spawn-elsewhere-oats-instance-suggest-name)). Local only: `--server` is `E_BAD_ARGS`. Gate on the local probe; without it, the spawn goes unnamed (numbered, or named where it lands) | |
| `spawn-apply-suggest-name` | `--suggest-name` on a spawn apply, without `--preview`: the apply names the instance as a preview's `--suggest-name` would, on the machine that spawns, and its result carries `naming` ([On an apply](#on-an-apply-feature-spawn-apply-suggest-name)). Routed, the host needs the feature (`E_REMOTE_INCOMPATIBLE`, nothing sent): gate on the host's `probe.features` and don't send the flag to a host without it | |
| `instance-background` | background instances (awebai/oats#1579): `soul.yaml` `background:`; `oats spawn … --background\|--no-background`, whose preview and result carry `background` and `backgroundFrom`; `oats instance background <instance> on\|off`, local and `--server`; `background: true` on `oats status --json` instance rows, `oats server roster --json` rows, `oats inspect --home` `instance` and `oats souls --json` soul rows, absent otherwise ([Background instances](#background-instances-oats-instance-background)). Gate on the probe, locally or in the host's `probe.features`: an older kernel refuses the flags and the verb, and its rows have no `background`. A routed spawn with either flag needs the host's feature (`E_REMOTE_INCOMPATIBLE`, nothing sent) | `instanceBackgroundApi: 1` (payload only) |
| `session-resume` | sessions come back after a shutdown, OATS 0.69 (#1559): `sessionEnd` on `oats status --json` instance rows ([`sessionEnd`](#row-session-end)); `oats session start --resume --home <abs>` and its `resume` answer ([Resume a lost session](#resume-a-lost-session---resume)); the machine sweep `oats session resume [--deployment <dir>] [--plan] --json` ([`oats session resume`](#the-machine-sweep-oats-session-resume)); `E_RESUME_BUSY`, `E_RESUME_NOT_LOST`. Local only: `--server` is `E_BAD_ARGS`. Gate a client's resume-on-open on the probe: a kernel without it has no `session resume` | |
| `warm-reader` | `oats reader --stdio`, the warm reader: a child process a client starts, which answers `oats status --json` and `oats workspace status --json` on its stdin and stdout, many times, with the CLI's own answers ([The warm reader](#the-warm-reader)). Gate on the probe, never by trying: a kernel without it has no `oats reader` | `readerApi: 1` |
| `status-liveness` | the local liveness on `oats status --json` instance rows is complete: `running` and `runtimeState` are read live at every call, from the row's recorded tmux server under the pane and shell-descendant rule, with `false` for a shell only on positive evidence and `null` when the reading is inconclusive ([The roster](#the-roster-oats-status---json)). A client needs no liveness probe of its own beside the roster where the probe lists it, whether the read goes through the warm reader or the CLI. Independent of `warm-reader` | |
| `wake-hold` | a scheduled wake sends no key while the home has a live `permission`, `question` or unknown-reason claim, or a claims read that can't be trusted: the run is `skipped`, `reason: "waiting-on-you"`, `pending: true`, with `held` ([A held wake](schedules.md#a-held-wake)); the `wake-held` event ([the event kinds](#events)); `wakeHold` on every successful `session inspect --json` ([Inspect, input and attach](execution-targets.md#inspect-input-and-attach)), from the hook answer `dialogClaims` ([Commands and hooks](capabilities.md#commands-and-hooks)). Gate on the feature, then on `wakeHold`: the feature says this kernel holds, `wakeHold` whether this home's dialogs become claims, and `unknown` is not covered | |
| `lifecycle-claim-start` | every `oats session start` and `oats session restart`, and a scheduled start, holds the home's lifecycle claim for the whole start (#1602), as `details.action: "start"`: a retire, a stop apply or an upgrade apply that arrives while it runs is refused `E_LIFECYCLE_BUSY` with `details.action: "start"`; the start or restart is refused `E_INSTANCE_RETIRING` beside a retire and `E_LIFECYCLE_BUSY` (with `details.holder` and `details.action`) beside a stop or an upgrade, before any effect; two starts still answer `E_SESSION_START_BUSY` ([Commands that meet on one home](#lifecycle-pairs)). A restart holds one claim across its stop and its launch. A kernel without it takes no claim for these, and reads a `start` holder as a retire | |
| `spawn-attribution` | the kernel validates who spawned an instance: `spawnedBy` (`{instance, home}` or `null`) in `instance.json`, on the `spawned` event and on `oats status --json` rows and remote rows, and `OATS_SPAWNER_HOME` for spawn hooks ([Spawned by](#spawned-by)); `attributedHuman` on `oats status --json` rows and on remote rows ([Attributed human](#attributed-human)). Absent: no `spawnedBy` and no `attributedHuman`, and a capability must not read a missing `OATS_SPAWNER_HOME` as a person's spawn | |
| `workspace-tasks-payload` | oats-workspace.yaml may carry a top-level `tasks:` payload, merged for the capability that fills the tasks slot exactly as `messaging:` is for the messaging one; its leaves' `settingsOrigins` are `{kind: "workspace", at: "oats-workspace.yaml#/tasks"}` ([Provider payloads have three homes](workspaces.md#provider-payloads-have-three-homes)). A kernel without it refuses a workspace file that carries `tasks:` (unknown property) | |
| `settings-committed-only` | a manifest `settings.<key>.committedOnly: true` is enforced: that key in oats-local.yaml `settings.<cap>` or a `--provider <cap>` flag is refused `E_WORKSPACE_SCHEMA` reason `committed-only-key`, with `details.layer`, `details.at` and `details.allowed` ([Commands and hooks](capabilities.md#commands-and-hooks)). A kernel without it ignores the flag and merges the key | |

Payload-only integers, never in the probe: `onboardApi: 2`, `syncApi: 1`,
`workspaceStatusApi: 1`, `capabilitiesApi: 1`, the `oats souls` document's
`soulsApi: 1`, `teamsApi: 1`, `soulTeamsApi: 1`, `triggerApi: 1`,
`soulLaunchApi: 1`.

**Gate on the probe, never by trying.** An older kernel can ignore an unknown
flag and act: without `lifecycle-plans`, `retire --plan` retires.

## Text output

A command's text (without `--json`) is for a person and is not part of this
contract. Some of its lines hold text the kernel did not write: a path as the
system or Git names it, a branch name, a hook's or a host's own words. In the
lines below, each character a terminal would act on, or that hides or
reorders text (a control character such as an escape or a newline, a bidi
override: the set the kernel never prints in text it did not write), is
spelled `\u{<hex>}` (OATS 0.53.0 for the local retire's warnings, #973; the
rest 0.56.0, #1006), so that such a name cannot clear the screen, write a
line of its own or reverse what follows it:

- the `note:` lines of `oats retire --plan`, `oats instance stop --plan`,
  `oats instance git` and `oats readiness`;
- the `WARNING:` lines of `oats spawn` (its preview, and with `--server`
  too), of the `oats session` commands (a start's or a restart's launch-hook
  warnings, on stderr) and of `oats doctor` (a pi bridge's version skew);
- the lines of `oats retire`, local and with `--server`, for the recovery it
  wrote, for the extra trees it handled and for the receipt's warnings. A
  retire with `--server` prints the receipt's warnings as a local one does.

A newline in such a value is spelled too, so the value stays on its line.
Text that already holds the characters of a spelling (`\u{1b}` written out)
prints as it is: a spelling is not meant to be read back. Every other line of
text output prints what it holds as it is. The JSON is never changed by
this: its strings are what they are.

## The envelope and dispatch errors

Every `--json` command except those below prints exactly one JSON object on
stdout (progress goes to stderr):

```json
{"schemaVersion":1,"ok":true,"result":{}}
```

```json
{"schemaVersion":1,"ok":false,"error":{"code":"E_BAD_ARGS","message":"--home needs an absolute instance home"}}
```

- Success exits 0, failure nonzero. `error.details` is present only when the
  command has details.
- <a id="kernel-codes"></a>**The lifecycle commands answer kernel codes only**
  (`oats retire`, `oats instance stop`, `oats session …`, `oats worktree
  add|remove`; feature `lifecycle-kernel-codes`, OATS 0.52.0). A kernel
  whose probe does not list the feature can answer one of these commands with
  the system's own code (`ENOENT`, `EACCES`, `ENOTEMPTY`) and has no
  `details.cause`: a client keeps its guard for such a code there. Routed
  with `--server`, one of these commands is answered by the host's kernel:
  gate on that host's list (`probe.features` of
  [`oats server roster --json`](#the-remote-roster-oats-server-roster---json)).
  A kernel code is `E_` followed by upper-case letters, digits
  and underscores (`^E_[A-Z0-9_]+$`). The kernel tests that shape, not a list
  of known codes, and the shape is enough: no dependency of the kernel gives
  an error whose code has that shape, and neither does the system (`ENOENT`)
  or Node (`ERR_…`).
  An error that is not the kernel's is answered with the command's general
  code (`E_LIFECYCLE_FAILED`, `E_SESSION_FAILED`, or the one its section
  names). What the answer adds depends on the error:
  - **One that has a code which is not a kernel code** gets
    **`error.details.cause`**, beside the command's other details:
    `{code, syscall}`. `code` is the system's (`ENOENT`), Node's (`ERR_…`),
    or one of the kernel's own lower-case names, which these commands wrap
    like the rest (`invalid-declaration`, `resource-limit`,
    `integrity-drift`, `invalid-source`); `syscall` only when the error has
    one.
  - **A defect of the kernel** gets `details.cause: {name}`, and its stack
    goes to stderr, in JSON and in text mode. A defect is an error without a
    code that is one of the language's own kinds, whose `name` is not
    `"Error"` (`TypeError`, `ReferenceError`, `RangeError`, `SyntaxError`, …),
    or a thrown value that is no error at all (`name` is then `"Error"`; it
    has no stack, and one line on stderr shows the value instead). It is
    answered as one envelope like the rest. One defect has a name of the
    kernel's own, `LateRefusal`: a stop or a retire met, after its first
    effect, an error whose code says that nothing happened
    ([the list](#before-effect-codes)).
  - **A refusal without a code** (the kernel words some of its refusals that
    way, and a `tmux` or `git` command that fails is reported that way) gets
    neither: the general code and its message alone, no `details.cause`, no
    stack. Text mode prints `oats: <message>`, as a kernel without the
    feature does.

  `cause` holds nothing else: no message, no path, no stack. The same rule
  holds for a `code` inside a result of these commands (a stop receipt's
  `results[].code`, a retire's `childrenStopped[].code`, a plan's
  `session.reason` and `work.reason`). **The one exception:** an OATS
  document with an unsafe mapping key or value is refused under its own name,
  `unsafe-config-key` or `unsafe-config-value`, by these commands as by every
  other; neither is wrapped. Elsewhere an `error.code` may still be the
  system's.
- Either envelope may carry `warnings: [ … ]`, only when there is something
  to say. The one warning is `deprecated-runtime-name`
  ([Harness input spellings](#the-harness-rename-feature-harness-oats-0270));
  in text mode it is an `oats: warning: …` line on stderr.
- `<kernel command> --help --json` answers `{command, usage}` and runs
  nothing.

| Not an envelope | stdout |
|---|---|
| `oats version --json` | the probe |
| `oats status --json` | the [roster document](#the-roster-oats-status---json) |
| a first `oats retire --json`, and a deferred self-retire | the raw [retire receipt](#retire) |
| `oats reader --stdio` | the reader's protocol lines ([The warm reader](#the-warm-reader)) |

<a id="flags"></a>
### Flag syntax

A kernel command reads `--flag=value` exactly as `--flag value` (the value is
everything after the first `=`). `E_BAD_ARGS` for an empty `--flag=`, a value
on a switch (`--yolo=false` never turns yolo on) and a value that is itself an
option (`--model=--yolo`). The one exception is the free-text `--message`
(`oats instance waiting`, `oats instance attention`): `--message=--text` is
accepted, and its value is only ever the message. A capability command's own flags are forwarded as
typed; the kernel reads only its dispatch flag (`--soul`). There is no feature
string for this: to support older kernels, use the spaced form.

<a id="command-flags"></a>
### The flags a command defines

These commands change state (and `oats teams`, `oats server check`,
`oats trigger poll` and `test`, which sit beside them), and each refuses a
flag it does not define before anything happens: before a plan is read, a
file is written, a process is stopped or started, and before a `--server`
command is sent to its host. A typo of a protective flag (`--no-recursve`
for `--no-recursive`) is never ignored.

| Command | Arguments | Flags that take a value | Switches | Refused in their own words | Its own answers |
|---|---|---|---|---|---|
| `oats retire` | `<instance>` | `--plan-revision`, `--idempotency-key`, `--home`, `--dir`, `--server` | `--plan`, `--self`, `--discard-worktree`, `--keep-dir`, `--force`, `--json` | `--delete-branch` | none |
| `oats spawn` | `<soul>` | `--agents-root`, `--backend`, `--base`, `--branch`, `--dir`, `--expect-decision`, `--harness`, `--herdr-socket`, `--idempotency-key`, `--instance`, `--launch-config`, `--max-age`, `--model`, `--name`, `--parent`, `--provider` (2 words), `--purpose`, `--relation`, `--relative-root`, `--relative-to`, `--repo`, `--runtime`, `--server`, `--task`, `--task-file`, `--trigger-event`, `--wake-cron`, `--wake-every`, `--wake-file`, `--wake-json`, `--wake-message`, `--wake-message-file`, `--wake-tz`, `--work`, `--work-dir` | `--allow-child-spawns`, `--background`, `--json`, `--no-background`, `--no-child-spawns`, `--no-launch`, `--no-yolo`, `--preview`, `--same-work`, `--suggest-name`, `--yolo` | `--instructions-file`, `--def-file`, `--ephemeral` | an unknown flag, an argument after the last |
| `oats sync` | none | `--dir` | `--plan`, `--json` | `--approve` | none |
| `oats instance stop` | `<instance>` | `--plan-revision`, `--idempotency-key`, `--grace-ms`, `--home`, `--dir`, `--server` | `--plan`, `--apply`, `--no-recursive`, `--json` | none | none |
| `oats instance upgrade` | `<instance>` | `--plan-revision`, `--idempotency-key`, `--home`, `--dir` | `--undo`, `--plan`, `--json` | `--server` | none |
| `oats instance color` | `<instance>` `[<color>]` | `--home`, `--dir`, `--server` | `--clear`, `--json` | none | none |
| `oats instance background` | `<instance>` `<state>` | `--home`, `--dir`, `--server` | `--json` | none | none |
| `oats instance same-work` | `<instance>` `<state>` | `--home`, `--dir`, `--server` | `--json` | none | none |
| `oats instance waiting set` | none | `--producer`, `--reason`, `--message`, `--home`, `--dir` | `--json` | none | none |
| `oats instance waiting clear` | none | `--producer`, `--reason`, `--message`, `--home`, `--dir` | `--json` | none | none |
| `oats instance attention` | none | `--message` | `--clear`, `--json` | `--home`, `--dir`, `--producer`, `--reason` | none |
| `oats instance suggest-name` | none | `--soul`, `--task`, `--task-file`, `--harness`, `--model`, `--launch-config`, `--dir` | `--json` | `--server` | none |
| `oats worktree add` | none | `--purpose`, `--branch`, `--base`, `--repo` | `--preview`, `--json` | `--server`, `--dir`, `--home` | none |
| `oats worktree remove` | none | `--purpose` | `--json` | `--server`, `--dir`, `--home` | none |
| `oats session start` | none | `--home`, `--instance`, `--launch-config`, `--harness`, `--runtime`, `--model`, `--server` | `--reselect-launch`, `--yolo`, `--no-yolo`, `--json`, `--resume` | `--native-record` | none |
| `oats session restart` | none | `--home`, `--instance`, `--launch-config`, `--harness`, `--runtime`, `--model`, `--server`, `--stop-grace` | `--reselect-launch`, `--yolo`, `--no-yolo`, `--json` | `--native-record`, `--resume` | none |
| `oats session resume` | none | `--deployment` | `--plan`, `--json` | `--native-record`, `--server` | none |
| `oats session input` | none | `--home`, `--text-file` | `--json` | `--native-record` | none |
| `oats session receive` | none | `--home`, `--name` | `--json` | `--native-record` | none |
| `oats session upload` | none | `--file`, `--home`, `--instance`, `--server` | `--json` | `--native-record` | none |
| `oats session attach` | none | `--detach-key`, `--home`, `--instance`, `--server` | `--no-status-line`, `--print`, `--json` | `--native-record` | none |
| `oats schedule add` | `[<id>]` | `--file`, `--spec-json`, `--description`, `--workspace`, `--runs-on`, `--owner`, `--dir`, `--server` | `--json` | none | none |
| `oats schedule update` | `<id>` | `--file`, `--spec-json`, `--description`, `--dir`, `--server` | `--json` | none | none |
| `oats schedule remove` | `<id>` | `--dir`, `--server` | `--force`, `--json` | none | none |
| `oats schedule run` | `<id>` | `--dir`, `--server` | `--force`, `--json` | none | none |
| `oats schedule enable` | `<id>` | `--dir`, `--server` | `--json` | none | none |
| `oats schedule disable` | `<id>` | `--dir`, `--server` | `--json` | none | none |
| `oats schedule reconcile` | `<id>` | `--dir`, `--server` | `--clear`, `--json` | none | none |
| `oats schedule tick` | none | `--dir`, `--server` | `--dry-run`, `--host`, `--json` | none | none |
| `oats schedule host install` | none | `--max-concurrent`, `--triggers-max-concurrent`, `--os`, `--dir`, `--server` | `--register-only`, `--print`, `--json` | none | none |
| `oats schedule host uninstall` | none | `--dir`, `--server` | `--json` | none | none |
| `oats host run` | none | `--stop-grace` | `--plan`, `--json` | none | none |
| `oats trigger add` | none | `--file`, `--from`, `--set`, `--id`, `--description`, `--workspace`, `--runs-on`, `--owner`, `--dir` | `--json` | none | none |
| `oats trigger poll` | `<id>` | `--dir`, `--max-age` | `--run-source`, `--json` | none | none |
| `oats trigger test` | `<id>` | `--dir` | `--run-source`, `--json` | none | none |
| `oats trigger remove` | `<id>` | `--dir` | `--json` | none | none |
| `oats trigger enable` | `<id>` | `--dir` | `--json` | none | none |
| `oats trigger disable` | `<id>` | `--dir` | `--json` | none | none |
| `oats teams` | none | `--dir`, `--max-age` | `--json` | none | an unknown flag, an argument after the last |
| `oats teams add` | `<label>` | `--dir`, `--team`, `--description` | `--no-default`, `--json` | none | an unknown flag |
| `oats teams remove` | `<label>` | `--dir` | `--json` | none | an unknown flag |
| `oats teams default` | `<label>` | `--dir`, `--expect` | `--if-absent`, `--json` | none | an unknown flag |
| `oats soul launch set` | `<soul>` | `--dir`, `--launch-config`, `--harness`, `--model` | `--plan`, `--json` | none | an unknown flag, an argument after the last |
| `oats soul launch remove` | `<soul or key>` | `--dir` | `--plan`, `--json` | none | an unknown flag, an argument after the last |
| `oats server check` | `<id>` | none | `--json` | none | none |
| `oats server remove` | `<id>` | none | `--json` | none | none |
| `oats server forget` | `<id>` | `--instance` | `--json` | none | none |
| `oats package add` | `<id>` `<version>` | `--dir` | `--json` | none | none |
| `oats package remove` | `<id>` | `--dir` | `--json` | none | none |
| `oats launch-config set` | `<name>` | `--file`, `--dir`, `--server` | `--keep-env`, `--json` | `--home`, `--soul` | none |
| `oats launch-config remove` | `<name>` | `--dir`, `--server` | `--json` | `--home`, `--soul` | none |
| `oats automations refresh` | none | `--dir` | `--json` | none | none |
| `oats update` | none | `--dir` | `--check`, `--yes`, `--json` | `--to` | an argument after the last |

An argument in brackets (`[<color>]`) is one the command may go without.
A flag marked with a number of words (`--provider`, two: `--provider
<capability> key=value`) takes that many.

The refusal is `E_BAD_ARGS`, with the command's usage line after the
message, and comes from the first problem from the left:

- a flag the command does not define: `oats <command>: unknown flag
  <flag>`, `error.details: {flag}`;
- a value on a switch: `oats <command>: <flag> takes no value (got
  <flag>=<value>)`, `error.details: {flag}`;
- an argument after the last one the command takes: `oats <command>:
  unexpected argument "<word>" after the <name> "<value>": <command> takes
  one <name>`, or `<command> takes no argument`, `error.details: {argument}`;
- a flag refused in its own words: that message (for example
  `--delete-branch` on retire, `--server` on `oats instance upgrade`),
  `error.details: {flag}`.

A command whose last column names an answer gives that one in its own words:

- `oats spawn`: `oats spawn: unknown flag <flag>`, and `oats spawn:
  unexpected argument "<word>" after the soul "<soul>": spawn takes one
  soul` (for a `key=value` word, `a capability setting is given as
  --provider <capability> key=value`), `E_BAD_ARGS` with no usage line and
  no `details`;
- `oats teams` and its forms, `oats soul launch set` and `remove`: the
  flag is `E_USAGE {flag}` in their words ([`oats teams`](#oats-teams),
  [`oats soul launch`](#oats-soul-launch)); a word where `oats teams`
  takes a form is `E_USAGE` with its usage; a second soul of `oats soul
  launch` is `E_BAD_ARGS`, `takes one soul, and got <n>: …`, naming
  every one;
- `oats update <word>`: ``oats update takes no package: pin package
  versions in oats-workspace.yaml (`oats package add <id> <version>`), then
  `oats sync`; …``, `E_BAD_ARGS`, `error.details: {argument}`.

Then, for a command given `--server`, a missing argument it requires is
`E_USAGE`, with the usage line as `error.message` and no `details`, and
nothing is sent. On this machine each command answers a missing argument
itself, as before (`oats retire` with no instance is `E_USAGE` too).

A flag that takes a value takes the next word (its number of words) unless
it starts with `--`; a value after `=` is its first. A value flag given
none (no word, or one that starts with `--`) ends the check there: it is
that flag's own refusal, by the command, before any flag after it. `--` is a flag like any other, and none of
these commands defines it. `--runtime` is the pre-0.27 name of
`--harness`. `--help` and `-h` print the usage first, as for every
kernel command.

### Dispatch errors

| Code | When |
|---|---|
| `E_UNKNOWN_COMMAND` | No kernel command or capability namespace matches; an unknown capability subcommand; a [removed verb](#removed-verbs-and-flags) (`details: {removed, replacement}`) |
| `E_CAPABILITY_INACTIVE` | In a home: the namespace's module is not one of the home's recorded capabilities |
| `E_CAPABILITY_BLOCKED` | In a home: the manifest claiming the namespace is not a workspace module copy of that home. There is no package trust gate |
| `E_CAPABILITY_BROKEN` | The manifest command is not a non-empty string, its script is missing or outside the module, or the dispatcher failed |
| `E_DUPLICATE_NAMESPACE` | Two modules claim the namespace |
| `E_CONFIG_BROKEN` | The home's `instance.json` or the deployment's configuration cannot be read |
| `E_LOCAL_MISSING` | No `oats-local.yaml` in reach of `--dir` or the working directory |
| `E_UNSUPPORTED_MODE` | A home or selector the kernel no longer runs (below) |

<a id="ssh-failures-e_ssh"></a>
### ssh failures (`E_SSH`)

A routed command (`--server`, and `oats server check`) reports ssh's own
failure as `E_SSH`, message `ssh to <host> failed: …`:

- `error.details` is `{"sshStarted": false}` when ssh never started on this
  machine (not installed, not executable): nothing reached the host, and
  retrying cannot help.
- No `details`: ssh ran and the link failed (unreachable host, refused key,
  lost connection, timeout); a retry may succeed.

(0.31.0; before it `E_SSH` never carried details.)

Capability dispatch inside a home uses the home's module copies; from a
deployment it resolves the module as `oats spawn --soul <x>` would and runs it
with the soul's merged payload. `oats <namespace> --help --json` answers
`{capability, namespace, command, commands, description, help}`.

`E_UNSUPPORTED_MODE` covers a home with no recorded `modules` (re-spawn it), a
captured home (`details: {home, captured: true}`), the selectors
`--deployment`, `--resolution` and `--artifact-set` (`details.selector`), and
an inherited `OATS_DEPLOYMENT` or `OATS_RESOLUTION` (`details.inherited`).
`oats version` and `oats retire` still work. `oats status --json` names such
homes in `problems[]`: `legacy-captured-home {code, instances, homes,
message}` and `legacy-local-agents {code, dirs, instances, message}`.

<a id="observation-reuse-feature-observe-max-age-oats-0311"></a>
### Observation reuse (feature `observe-max-age`, OATS 0.32.0)

Every read asks each remote for its current head (`git ls-remote`). With
`--max-age <seconds>` a read verb reuses a head this machine observed at most
that many seconds ago instead, so a refresh right after another costs no
network round trip. `oats workspace status` reuses the host's `gh` login the
same way, for display only ([below](#the-gh-login-display-only)). Gate the flag on the feature: an older kernel may ignore
it and answer live, without the block.

```text
oats status | workspace status | souls | capabilities | inspect --soul|--home
     | teams | soul teams <soul>   … --max-age <seconds> --json
oats spawn <soul> … --preview --max-age <seconds> --json    (feature spawn-preview-max-age)
oats spawn <soul> … --expect-decision <revision> --max-age <seconds> --json   (feature spawn-apply-max-age)
oats capabilities show <name> … --max-age <seconds> --json  (feature capability-show)
oats trigger poll <id> --run-source … --max-age <seconds> --json   (feature trigger-sources)
```

- **Values:** whole seconds, `0` to `86400`. `0` is live: it reuses nothing.
  Anything else is `E_BAD_ARGS` (`--max-age needs a value: whole seconds from 0
  to 86400`, `--max-age takes whole seconds from 0 to 86400, got "<v>"`).
- **The block:** with the flag (`0` included) the document gains one key,
  `observation: {observedAt, reused, localRevision}`: in the result of an
  envelope, at the top level of the roster (after `agents`). `observedAt` is the
  OLDEST remote observation the answer used (a head, or a reused `gh` login),
  so the answer is at least that fresh everywhere; `reused` is `true` when any
  head or that login came from an earlier observation.
  A command that used no remote observation (no head, and no reused `gh`
  login) reports the time it started and `reused: false`. Without the flag the key is absent and every document is
  exactly as before. A refusal (`E_SOUL_UNKNOWN`, any error envelope) never
  carries the block.
- **Spawn preview** (feature `spawn-preview-max-age`, OATS 0.33.0): the
  preview's `result` gains the same block, so you can say "as of
  `<observedAt>`". The `decision` covers the heads the preview used, reused
  or live: a reused head the member has since moved from makes an apply
  that observes live refuse `E_DECISION_STALE`, and the apply records the
  head it observed, so the next preview under `--max-age` shows it with a new
  `decision.revision`. The preview-bound apply takes the flag from
  `spawn-apply-max-age` (OATS 0.58.0): with `--expect-decision`, it reuses
  heads as the preview does, and its decision fence is unchanged
  ([Apply](#apply)). Its answer carries no block.
- **`localRevision`:** 24 lowercase hex characters, opaque. It digests every
  piece of local configuration the kernel read for this answer:
  `oats-local.yaml` (and each closer `oats-local.yaml` it looked for and did
  not find), `oats-lock.json`, an `OATS_PACKAGE_CATALOG` file, and the
  automations snapshot. Only what the verb actually read counts. The same inputs
  give the same revision; any byte change, or one of those files appearing or
  disappearing, gives another. It names no path and no content. Different verbs
  read different inputs (`workspace status` also reads the automations
  snapshot; `inspect --home` reads no lock), so compare revisions of the same
  verb and arguments only. Keep what you
  hold (catalogs, inspect results) keyed on it: a different revision means the
  deployment's configuration changed outside you (a `teams` edit, a sync, a
  hand edit). A kernel upgrade shows through the probe (`oats version --json`),
  not through `localRevision`: the bundled catalog is not an input. Instance
  homes, member clones and tmux are not inputs either, because the answer
  itself reports them.
- **What is reused:** remote heads (the commit a branch or tag named) and,
  in `workspace status`, the `gh` login it places automations with; never
  local state. Instances, `oats-local.yaml` and the lock are read afresh
  by every command. A member's backlink (`oats-membership.yaml`) is read at
  the member's observed head, which may be a reused one: a backlink removed
  less than `<s>` seconds ago can still show the member `confirmed` under
  `--max-age <s>`. Only the backlink's comparison with this workspace is made
  afresh. A reused head's
  `observedAt` (for example `workspace.observedAt` in `workspace status`) is
  the time it was observed, not now.
- <a id="the-gh-login-display-only"></a>**The `gh` login, display only:**
  `workspace status` places each workspace trigger and schedule
  with the account this host's `gh` is logged in as (`gh api user`;
  [who runs it](schedules.md#workspace-triggers-and-schedules)). Under `--max-age <s>`
  it reuses a login a status read observed at most `<s>` seconds ago, so a
  client polling every few seconds asks GitHub about once per `<s>`. Only
  that display does: a schedule tick, `oats trigger poll` (with `--max-age`
  too), `oats trigger run` and every other act that places or fires an
  automation asks `gh` live. A login is reused only under the same `gh`
  context: the same GitHub host, the same `gh` binary (as `PATH` finds it
  from the deployment), the same set of token variables (`GH_TOKEN`,
  `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`: which are
  set, never their values), the same `GH_HOST` and config directory, and an
  unchanged `hosts.yml` there (a `gh auth login`, `logout` or `switch`
  rewrites it). Only a successful answer is kept, never a token or its
  digest; a failed one is not, and it ends the reuse of the success before
  it. Within `<s>`, a token variable given another value or a token revoked
  on GitHub still shows the login, as a head moved on the remote shows
  unmoved. The display waits at most 5 s for `gh` (an act waits 30 s): a
  `gh` that does not answer in time reads `owner-mismatch`, as one that is
  not logged in does.
- **When a head is not reused:** it is older than the flag allows (or dated
  more than 5 s in the future); it was observed through a different URL
  spelling of the same repository (ssh vs https) or for a different ref; its
  commit can no longer be fetched. Each is observed live, as without the flag.
  A live observation that fails is the usual error, never an older head.
- **Refusals:** every other command, every edit form (`teams add|remove|default`)
  and any `--server`
  invocation refuse the flag before reading or writing anything (the removed
  `soul teams --add|--remove|--default|--clear-default` answer their own
  `E_BAD_ARGS` first), with
  `E_BAD_ARGS` "--max-age is not accepted by \`oats <form>\`: only the read
  verbs and a preview-bound spawn apply reuse observations (status, workspace
  status, souls, capabilities, capabilities show, inspect --soul|--home,
  spawn --preview, spawn --expect-decision <revision>, trigger poll, and the
  read forms of teams and soul teams)" and,
  with `--server`, "--max-age cannot be combined with --server: observation
  reuse is local to this machine". A spawn apply without `--expect-decision`
  (or with no value after it) refuses it with `E_BAD_ARGS` "--max-age is not
  accepted by \`oats spawn\` without --expect-decision: a spawn apply reuses
  observations only with --expect-decision <revision>, which binds it to the
  decision a preview showed". Write verbs refuse the flag because a writer
  acting on a reused observation could persist a fact the workspace no longer
  holds; a preview-bound apply is the exception because its fence binds it to
  the decision the operator confirmed.
  A capability command's argv (`oats <namespace> …`) is its provider's: the
  kernel neither reads nor refuses `--max-age` there. The same holds for
  `capture`, `recall`, `setup` and `experimental`, which parse their own argv:
  `capture`, `setup` and `experimental` refuse it as an unknown argument (not
  `E_BAD_ARGS`), and `recall` ignores unknown flags.

The observations are kept under the remote cache
(`$OATS_REMOTE_CACHE`, default `~/.cache/oats/remotes`), in `.observed/`,
beside the bounded parsed-read cache in `.parsed/`. An observation record
keeps a digest of the fetch URL, never the URL. A parsed entry keeps repository
content as committed (member refs included), and a value that carries a
credential-bearing URL (userinfo on http(s), or `user:password@` on any
scheme) is never written. Deleting either is always safe.

<a id="inspect-readiness-and-operation-run-on-the-workspace-model-operationsapi-2-soulsapi-2-readinessapi-2-oats-0260"></a>
## Inspect, readiness and operation run

These answer about one **subject**: an instance home (`--home <abs>`) or a
soul of a deployment (`--soul <name> [--dir <d>]`).

| Command | Integer |
|---|---|
| `oats inspect --json` | `operationsApi: 2`; each `souls[]` row `soulsApi: 2` |
| `oats readiness --json` | `readinessApi: 2` |
| `oats operation run --json` | `operationsApi: 2` |

**Addressing.**
- `--home` reads the home's `instance.json` and its module copies under
  `<home>/.oats/modules/`. The home must be
  `<deployment>/agents/<soul>/instances/<name>` with
  `<deployment>/oats-local.yaml` exactly there, else `E_HOME_MISMATCH
  {home, expected}`. A `--dir`, `--agents-root` or `--soul` that disagrees
  with it is `E_HOME_MISMATCH`. An unreadable home is `E_SESSION_UNKNOWN`; a
  home without `modules`, or a captured one, is `E_UNSUPPORTED_MODE`.
- `--soul` resolves the soul exactly as a spawn would (discovery, the soul's
  `capabilities:` plus workspace defaults, the lock). No `oats-local.yaml` is
  `E_LOCAL_MISSING`; an `--agents-root` other than `<deployment>/agents` is
  `E_SOUL_UNKNOWN`.
- Neither is `E_BAD_ARGS`. `PI_AGENTS_ROOT` is ignored.

A module's origin (`from`) is `{kind: "member", repoKey, commit}` or `{kind:
"package", package, version, commit, integrity, repoKey}`.

<a id="oats-inspect---home-----soul----dir----json--operationsapi-2"></a>
### `oats inspect`

```text
oats inspect (--home <abs> | --soul <name> [--dir <d>] [--instructions] [--skills] [--composed-skills]) [--max-age <s>] --json
```

An instance subject, abridged:

```json
{"operationsApi":2,"kernel":"0.30.0",
 "subject":{"kind":"instance","instance":"rm-1","home":"/w/agents/rm/instances/rm-1","soul":"rm"},
 "workspace":{"key":"github.com/nw/agents","name":"northwind","deployment":"/w","commit":"66566512…","standalone":false},
 "souls":[{"soulsApi":2,"name":"rm","repoKey":"github.com/nw/agents","commit":"66566512…","kind":null,"path":null,
   "description":"Cuts releases.","work":"worktree","harness":null,"model":null,
   "declarations":{"requires":null,"defaults":null,"knowledge":{"owns":"rm","reads":[]},"resources":null,"children":null,"capabilities":{"oats.okf":{"from":"package"}}},
   "declarationProblems":[],"instructions":{"file":"/w/agents/rm/souls/66566512168e/AGENTS.md","text":"# rm\n","truncated":false}}],
 "layers":{"knowledge":{"id":"oats.okf","from":"workspace"},"messaging":{"id":null,"from":null},"tasks":{"id":null,"from":null}},
 "capabilities":[{"id":"oats.okf","version":"2.1.3","layer":"knowledge","command":"okf",
   "from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"},
   "composedFrom":null,"dir":"/w/agents/rm/instances/rm-1/.oats/modules/oats.okf","settings":{"owns":"rm","reads":[]},
   "declares":["state-dir"],"compatibility":{"ok":true,"range":">=0.24.0","kernel":"0.30.0"},"missingRequires":[],
   "operations":[{"name":"status","kind":"view","command":"status","context":"home","description":"Knowledge status","args":[],
                  "argv":["okf","status"],"available":true,"reason":null}]}],
 "capabilitiesOff":[],
 "teams":[{"label":"eng","team":null,"default":true,"from":"shared"},{"label":"mine","team":"mine:ana.aweb.ai","default":false,"from":"local"}],
 "defaultTeam":{"label":"eng","team":null,"from":"soul"},"teamsSource":"live",
 "recordedDefaultTeam":{"label":"eng","team":null,"from":"soul"},
 "knowledge":{"provider":"oats.okf","version":"2.1.3","operations":[{"name":"status","kind":"view","available":true,"reason":null}]},
 "instance":{"home":"/w/agents/rm/instances/rm-1","instance":"rm-1","agent":"rm","harness":"pi","model":null,"yolo":null,"launched":false,
   "createdAt":"2026-09-28T10:08:01.281Z","color":null,"resolution":"abacbdb5a7975098d77007c8","soulDir":"/w/agents/rm/souls/66566512168e",
   "instructions":{"file":"/w/agents/rm/instances/rm-1/AGENTS.md","text":"…","truncated":false,
                   "sources":[{"source":"capability:oats.okf","file":"/w/agents/rm/instances/rm-1/.oats/modules/oats.okf/injects/okf.md"}]}},
 "identity":null,
 "problems":[]}
```

| Key | Meaning |
|---|---|
| `subject` | `{kind: "instance", instance, home, soul}` or `{kind: "soul", soul, repoKey, commit}` |
| `workspace` | `{key, name, deployment, commit, standalone}`; for a home, `name` is the recorded name (`null` if the spawn predates it). `standalone` is the view the subject resolves in (a fallback for an unreadable host included), unlike `oats status`'s configured-only [`standalone`](#workspace-identity-feature-workspace-identity-oats-0360) |
| `souls` | exactly the subject's soul |
| `layers` | `{knowledge, messaging, tasks}`, each `{id, from}` |
| `capabilities`, `capabilitiesOff` | the resolved modules (by id) and the ones the soul turned off |
| `teams`, `defaultTeam`, `teamsSource`, `recordedDefaultTeam` | [Where teams appear](#where-teams-appear); `recordedDefaultTeam` is home only |
| `knowledge` | `{provider, version, operations: [{name, kind, available, reason}]}` for the knowledge slot (`null`s and `[]` when empty) |
| `instance` | `null` for a soul; the home's facts above. `instructions.sources` lists each composed inject in order. `color` (feature `instance-color`) is the instance's colour or `null` ([An instance's colour](#an-instances-colour-oats-instance-color)) |
| `identity` | home only (absent for a soul): the served identity a messaging provider recorded, `{…, provider}`, or `null`. Read on every call, so after a start whose launch hook returned new `meta` it is that start's record, not the spawn's |
| `problems` | below |
| `warnings` | always present (0.49.0): [capability warnings](#capability-warnings-hook-event-unsupported-oats-0490); for `--home`, `path` is home-relative |

**Soul row** (`soulsApi: 2`). For a home it is read from the recorded
`soulDir` (`path` and `kind` are `null`); for a soul it is the member's current
definition (`kind` is `member` or `external`, `path` inside the member).
`declarations` is `{requires, defaults, knowledge, resources, children,
capabilities}`, each the soul.yaml section as written or `null`.
`instructions` is `{file, text, truncated}` of the soul's `AGENTS.md`, or
`null` before a spawn has copied the soul. `declarationProblems` holds
`soul-declarations-unreadable` when soul.yaml does not parse.

`composedInstructions` (feature `soul-composed-instructions`) is present only
with `--instructions`, which takes a soul subject (`--home` is `E_BAD_ARGS`);
without the flag the key is absent and nothing extra is composed. It is the
AGENTS.md a spawn of this soul here with no flags would write, produced by
spawn's own composition — each capability's inject, then the kernel blocks,
materialized into a scratch home outside the deployment and removed. It is
`{file: null, text, truncated, resolution, body, sources}`. `text` and
`truncated` follow the 200,000-character cap of `instructions`; `resolution` is
the resolution revision it was composed at. `body` is the soul's own AGENTS.md,
`{start, end, truncated}`, and `body.start` is always 0. `sources` lists each
block in text order like `instance.instructions.sources`, as `{source, file,
start, end, truncated}`: `source` is the marker's (`kernel:instance-boundary`,
`work-mode:<mode>`, `capability:<id>`). `file` is home-relative by design here
— `.oats/modules/<id>/<inject>` for a capability, `null` for a kernel block —
while `instance.instructions.sources[].file` is a host path: same key,
different base. Ranges are `[start, end)` into `text` in JavaScript string
units; `sources` is contiguous with `body` and with each other, with no
overlaps (each part ends after the blank line that separates it from the
next). A block's range includes its opening and closing marker lines. Ranges
are clamped to `text`: a part cut by the cap has `truncated: true` and may lack
its closing marker, and one wholly past the cap has `start == end ==
text.length`. The text equals what the spawn writes except that capability
markers' `src=` is home-relative. It is `null` when the soul resolves but
cannot be composed here, with the kernel's code and sentence, naming
`composedInstructions`, in `problems[]`. Routed with `--server <id>`, the flag
travels to the host; a host whose probe does not advertise
`soul-composed-instructions` is refused with `E_REMOTE_INCOMPATIBLE`, and
nothing is sent.

`skills` (feature `soul-skills`) is present only with `--skills`, which takes
a soul subject (`--home` is `E_BAD_ARGS`) and combines with `--instructions`;
without the flag the key is absent and no skill file is read. It lists the
soul's own skills, exactly the ones a spawn of it copies (not its
capabilities' skills), read from the same soul copy as `instructions`:

```json
"skills":[{"name":"release-checklist","path":"skills/release-checklist","description":"Cutting a release.",
           "files":[{"path":"skills/release-checklist/SKILL.md","bytes":812,"text":"---\nname: release-checklist\n…","binary":false,"truncated":false},
                    {"path":"skills/release-checklist/references/notes.md","bytes":2048,"text":null,"binary":false,"truncated":false,"omitted":true}],
           "filesTruncated":false}]
```

- `skills` is the list sorted by `name` in codepoint order; `[]` when the
  soul has no skills of its own (no `skills/` directory, or none with a
  `SKILL.md`); `null` when they could not be listed, with a problem below,
  including a skill directory whose `SKILL.md` could not be examined.
  It is also `null` when the soul's copy failed, and that copy's problem
  explains it.
- A skill is a child directory of `skills/` holding a regular-file
  `SKILL.md`, or `skills/` itself when it holds one (`name` is then
  `skills`). `path` is POSIX and relative to the soul directory. Its
  `description` is the `SKILL.md` front matter's `description`, by the same
  function as [`oats capabilities show`](#oats-capabilities-show), which reads
  the file up to 4 MiB: `null` when the file is unreadable, a symbolic link,
  binary or over 4 MiB, or has no such string, and cut to 1024 bytes.
- `files` is every regular file under the skill directory, recursively,
  sorted by `path` in codepoint order, each `path` relative to the soul
  directory. At most 200 are listed; beyond that `filesTruncated` is `true`.
  `files` is `null` (and `filesTruncated` `false`) when the files could not
  be listed: an entry whose name is not a safe path component (`.git` in any
  case, a backslash, a control character), or a listed file that cannot be
  read safely (unreadable, gone, changed type, or refused as below). Could
  not list never reads as listed nothing.
- A file is `{path, bytes, text, binary, truncated}`, by `oats capabilities
  show`'s rules: `bytes` is its real size; `binary` (a NUL or invalid UTF-8
  in its first 262,147 bytes) has `text: null` and `truncated: false`;
  otherwise `text` is at most 262,144 bytes, cut on a code point boundary,
  and `truncated` says it was cut.
- The whole field carries at most 1 MiB (1,048,576 bytes) of `text`, as
  UTF-8, summed over its files in answer order. The file whose text would
  pass that, and every file after it, has `text: null, binary: false,
  truncated: false, omitted: true`; no other file has `omitted`, and a binary
  file costs nothing. So `text` is `null` only with `binary: true` or
  `omitted: true`.
- No symbolic link is followed. A symlinked file or directory inside a skill
  is not listed, a symlinked skill directory is not a skill, and a symlinked
  `skills/` makes `skills` `null` with a problem. FIFOs, sockets and devices
  are not listed and never opened. A directory is listed, and a file read,
  only once its real path lies inside its skill's, and the skill's inside the
  soul's; one that does not makes the skill's `files` `null`. A file is
  opened without following a symbolic link and must be the regular file the
  listing found. One race remains: a parent directory swapped for a symbolic
  link in the instant between that check and the open can redirect a read.
  Only someone who can write the deployment's `agents/` tree can do that, and
  they already control the soul copy and every instance's `AGENTS.md`.
- Problems are `{code, message}` in `problems[]`, each message starting
  `skills: `: `soul-skills-unreadable` when the list is `null`, and
  `soul-skill-files-unreadable`, naming the skill's `path`, for a skill whose
  `files` is `null`.

Routed with `--server <id>`, `--skills` travels to the host; a host whose
probe does not advertise `soul-skills` is refused with `E_REMOTE_INCOMPATIBLE`,
and nothing is sent. Every text is untrusted repository content: render it as
plain text or through a sanitising renderer.

`composedSkills` (feature `soul-composed-skills`) is present only with
`--composed-skills`, which takes a soul subject (`--home` is `E_BAD_ARGS`) and
combines with `--instructions` and `--skills`; without the flag the key is
absent and nothing extra is composed. It lists every skill an instance of this
soul gets: the soul's own and each capability's.

```json
"composedSkills":[{"name":"oats-operate","source":"module:oats.core","path":".oats/modules/oats.core/skills/oats-operate",
                   "description":"…","files":[{"path":".oats/modules/oats.core/skills/oats-operate/SKILL.md","bytes":1234,"text":"…","binary":false,"truncated":false}],
                   "filesTruncated":false},
                  {"name":"release-checklist","source":"soul","path":"skills/release-checklist","description":"Cutting a release.",
                   "files":[…],"filesTruncated":false}]
```

- One row per skill, sorted by `name` in codepoint order. `source` is
  `"soul"` or `"module:<capability id>"`, the vocabulary of `instance.json`
  `skills` and of the spawn preview.
- `path` is POSIX. A soul skill's is relative to the soul directory, as in
  `skills`; a capability skill's is relative to the instance home, where the
  instance carries the capability's copy (`.oats/modules/<id>/…`). Each
  file's `path` starts with its skill's.
- The rest of a row, and every rule for its files, is `skills`' above, with
  one difference: the whole field carries at most 2 MiB (2,097,152 bytes) of
  `text`, summed over every file in answer order, whichever source it comes
  from. Problems name `composedSkills: ` instead of `skills: `.
- It is computed by the same scratch materialization as `--instructions`
  (one serves both when both are given): the soul's skills by the
  enumerator spawn uses, read from the soul copy, and the capability skills
  materialize placed, read from the scratch copy before it is removed. It
  runs no hooks and writes nothing in the deployment.
- It is `null` when a spawn would refuse a collision between a soul skill and
  a capability skill (names compare case-insensitively), with the problem
  `{code: "E_SKILL_DUPLICATE", message: "composedSkills: skill \"<name>\"
  from soul collides with module <id>'s skill"}`, the sentence spawn refuses
  with. It is `null` when the soul resolves but cannot be composed here, with
  the composition's code and sentence, naming `composedSkills`. It is `null`
  with `soul-skills-unreadable` when the soul's own skills cannot be listed.

Routed with `--server <id>`, `--composed-skills` travels to the host; a host
whose probe does not advertise `soul-composed-skills` is refused with
`E_REMOTE_INCOMPATIBLE`, and nothing is sent.

**Layers.** `id` is the capability filling the slot or `null`. `from`
(feature `layers-from`) is `"soul"` or `"workspace"`, `null` for an empty slot
or a home spawned before it was recorded.

**Capability rows.**
- `dir` is the home's module copy, `null` for a soul.
- `composedFrom` (feature `desktop-facts`): `"workspace"` or `"soul"` for a
  soul subject; `null` for a home.
- `settings` is the merged provider payload; `declares` (feature
  `settings-declared`) the manifest's setting keys, sorted.
- `compatibility` is `{ok, range, kernel}` (`range` is the manifest's
  `compatibility.oats` or `null`). A soul's resolution refuses an incompatible
  module, so `ok: false` appears only for a home.
- `missingRequires`: `{command, why, install}` for each manifest `requires`
  command absent from `PATH`.
- `operations[]`: the declared operation (`name`, `kind`, `command`,
  `context`, `description`, `args`) plus `argv`, `available` and `reason`
  (for example a missing command, or a `context: "home"` operation on a soul).

**`capabilitiesOff[]`** (feature `desktop-facts`): `{id, off: true, from:
"soul", reason, slot?, overrides}`, sorted by id. `reason` is `"off"` (the
soul wrote `<id>: off`) or `"slot-none"` (the soul wrote `<slot>: none`,
emptying the slot the workspace filled with `<id>`). `overrides` is the layer
whose default was turned off (`"workspace"`). `[]` for a home.

**Problems:** `soul-declarations-unreadable`, `module-manifest-invalid`,
`module-missing {capability}`, `capability-incompatible {capability, range,
kernel}`, and for a home whose discovery failed, that error's `{code,
message}`.

A soul whose resolution is refused is an inspect error with the resolver's
code and details (`E_PACKAGE_MISSING`, `E_PACKAGE_INTEGRITY`,
`E_CAPABILITY_MISSING`, `E_LOCK_SCHEMA`, `E_TEAM_UNKNOWN`, and
`E_WORKSPACE_SCHEMA` reason `local-teams-closed`); readiness reports the same
condition as an item. Soul lookup errors are those of [spawn](#spawn-errors).

<a id="oats-readiness---home-----soul----dir----policy---json--readinessapi-2"></a>
### `oats readiness`

```text
oats readiness (--home <abs> | --soul <name> [--dir <d>]) [--policy] --json
```

```json
{"readinessApi":2,
 "subject":{"kind":"soul","soul":"rm","repoKey":"github.com/nw/agents","commit":"66566512…"},
 "selector":{"kind":"soul","soul":"rm","agentsRoot":null,"dir":"/w"},
 "at":"2026-09-28T10:07:57.549Z",
 "checks":{
  "installed":{"status":"pass","items":[{"subject":"oats.okf","status":"pass","required":true,"reason":null,"producer":"workspace resolution",
    "evidence":{"from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"}},
    "remedy":null,"capability":{"id":"oats.okf"}}]},
  "configured":{"status":"not-applicable","items":[]},
  "member":{"status":"pass","items":[{"subject":"member github.com/nw/agents","status":"pass","required":true,"reason":null,
    "producer":"workspace discovery","evidence":{"repoKey":"github.com/nw/agents","workspace":"github.com/nw/agents","commit":"66566512…"},"remedy":null}]},
  "providers":{"status":"fail","items":[{"subject":"oats.okf","status":"fail","required":true,"reason":"setting state-dir is required",
    "producer":"provider binding check","evidence":null,"remedy":null,
    "result":{"status":"needs-configuration","problems":[{"code":"needs-configuration","message":"setting state-dir is required"}],"warnings":[]},
    "capability":{"id":"oats.okf"}}]}},
 "summary":{"ready":false,"required":3,"pass":2,"fail":1,"unknown":0,
   "byCapability":[{"capability":{"id":"oats.okf"},"checks":{"installed":"pass","configured":"not-applicable","member":"not-applicable","providers":"fail"},"ownReady":false,"ready":false}],
   "subjectBlockers":[]},
 "notes":["ready means every REQUIRED check passes; it is never inferred from an empty set"]}
```

- `selector` echoes the arguments byte-exact: `{kind: "soul", soul,
  agentsRoot, dir}` or `{kind: "home", home, soul, agentsRoot}`.
- Four checks, each `{status, items}`. An item is `{subject, status,
  required, reason, producer, evidence, remedy}`, plus `capability: {id}` on a
  per-capability item and the keys named below. Statuses are `pass | fail |
  unknown | not-applicable`. An item's `reason`, `remedy` and kernel
  `problems[].message` are at most 1000 characters (0.44.0). Longer text,
  such as a remote error, is clipped with `…`. A provider's `result` is
  relayed verbatim.
- A check's status rolls up its required items (any `fail` → `fail`, else any
  `unknown` → `unknown`, else `pass`; `not-applicable` with none required).
- `summary.ready` is true when every required item passes or is
  not-applicable and at least one required item exists; the counts are over
  required items. `byCapability[]` is `{capability, checks, ownReady,
  ready}` (`ready` also needs no subject blocker). `subjectBlockers[]` is
  `{check, subject, status}` for each failing required item not about a
  capability. `notes` is prose.
- `warnings` (0.49.0) is always present: the
  [capability warnings](#capability-warnings-hook-event-unsupported-oats-0490)
  of the subject's capabilities. They are not items and change no status.

**`installed`**, one item per module with `evidence: {from}`. `--home`
(producer `instance modules`): passes when the home's copy holds `oats.json`
(remedy on failure: spawn a new instance). `--soul` (producer `workspace
resolution`): each resolved module. A resolution refusal is one failing item about the soul
with `code`, the message as `reason`, the details as `evidence` and a remedy
naming `oats sync`; team refusals go under `configured` instead.

**`configured`.** Producer `capability manifest`: each manifest `requires`
command, `evidence: {command}`, the manifest's `install` hint as remedy.
Producer `team model`: the soul's [team readiness items](#team-readiness-items).
Producer `operator coverage` (0.44.0): the workspace's and the soul's teams'
[operator coverage items](#operator-coverage-items), warnings only.

**`member`** (producer `workspace discovery`): the soul's repository is a
confirmed member (`evidence: {repoKey, workspace, commit}`); `fail` when not
(the remedy names `oats-membership.yaml`); `unknown` when the workspace could
not be read. External souls and standalone views are `not-applicable`,
`required: false` (a standalone item carries `evidence.standaloneReason`).
A package soul is trusted through the workspace's `packages:` pin, never
through membership ([the non-collapse rule](workspaces.md#member-tier-vs-package-tier-the-non-collapse-rule)):
its item is `package <package>/<soul>` (producer `workspace lock`,
`evidence: {repoKey, workspace, commit, version, integrity, from}` with
`from.kind: "package"`). It passes when the package is declared and locked
and ships the soul at the locked commit, and the soul's copy is intact: for
`--soul`, the copy a spawn would link matches the locked digest; for
`--home`, the home's copy matches the digest it recorded, and a lock still
at that commit records the same digest. The copy is digested on every read.
It fails otherwise, with `code: "E_PACKAGE_INTEGRITY"` on a digest mismatch
and the remedy naming `oats sync` or a fresh spawn. When the package is no
longer locked, readiness cannot tell a deliberate drop from an accidental
unpin or a pending sync, so the `--home` remedy names both, the respawn
first: if the workspace dropped the package on purpose, spawn a new instance
from a soul the workspace offers, then retire this one; otherwise declare the
package in `packages:` and `oats sync`. For `--soul` it is declaring the
package and `oats sync`.

**`providers`** (producer `provider binding check`): for each module whose
manifest declares `binding`, the kernel runs its `binding.check` and relays
the answer as `item.result: {status, problems, warnings}`. The request,
environment and validation are in
[capabilities.md](capabilities.md#readiness-check-bindingcheck).

| `result.status` | item `status` |
|---|---|
| `ready` | `pass` |
| `needs-configuration`, `authorization-required` | `fail` |
| `unavailable` | `unknown` |

- `reason` is the first problem's message. `warnings` is always present and
  never changes the status.
- A provider that cannot answer is `unknown` with `result: null` and
  `item.problems: [{code, message}]`: its refusal code,
  `provider-unavailable`, `resource-not-found` (the check executable is not a
  regular file in the module, or a member module checked from `--soul`),
  `provider-not-qualified`, or a module-store error.
- One budget per read: 60 s total, 30 s per check; an unreached check is
  `unknown` with `time-budget-exhausted`.

**`--policy`** adds `policy` and a note:

```json
{"childSpawns":{"allowed":true,"enforced":true,"origin":{"kind":"default","detail":"no recorded policy: children allowed (pre-0.24.8 instance)"}},
 "worktrees":{"allowed":false,"mode":"directory","enforced":true,"origin":{"kind":"work-mode","detail":"work: directory"}}}
```

With `--home` it is the recorded, enforced policy; with `--soul`, the soul's
declaration (`children.spawn`, `work`) with `enforced: false`. The spawn route
enforces `childSpawns`: a child spawn under a parent whose policy is off is
`E_CHILD_SPAWNS_DISABLED {parent, policy}`, before anything is created.

### `oats operation run`

```text
oats operation run <layer>:<name> (--home <abs> | --soul <name> [--dir <d>]) [--arg k=v …] --json
```

```json
{"operationsApi":2,"operation":"knowledge:status","capability":"oats.okf","version":"2.1.3","argv":["okf","status"],
 "cwd":"/w/agents/rm/instances/rm-1","target":{"home":"/w/agents/rm/instances/rm-1","instance":"rm-1"},
 "result":{"documents":[{"label":"Working state","kind":"markdown","text":"…"}]}}
```

- `<layer>` is `knowledge`, `messaging` or `tasks`; `<name>` matches
  `[a-z][a-z0-9-]*` (`E_BAD_ARGS` otherwise).
- The provider is the module filling the slot. `cwd` is the home for a
  `context: "home"` operation, else the deployment; `target` is `{home,
  instance}` or `null`.
- A launched `instance` or `home` named by the provider's result is repeated
  at the top level; `stderr` appears when the provider wrote any.
- A `view` operation must answer `{documents: [{label, kind?, path?, text?}]}`
  (`kind` `markdown` or `text`), else `E_OPERATION_RESULT`.
- Errors: `E_OPERATION_UNKNOWN`, `E_OPERATION_UNAVAILABLE` (empty slot, or a
  home operation without `--home`), `E_CAPABILITY_REQUIRES`, `E_BAD_ARGS`
  (undeclared or missing `--arg`), `E_CAPABILITY_BROKEN`. A provider's `ok:
  false` is relayed with its code and `details: {exit, envelope,
  unconfirmed?}`. A literal provider `error.details.unconfirmed: true` is
  promoted to the outer details while its full envelope stays nested. Existing
  retained-effect text checks remain for compatibility during migration.
  `E_OPERATION_TIMEOUT` (240 s) and `E_OPERATION_RESULT` are
  unconfirmed outcomes: `details: {exit, signal, unconfirmed: true,
  envelope?, stderr?, cleanup?}`.

`--server <id>` routes inspect and operation run when the destination
advertises `operations`.

**Knowledge operations.** Discover a knowledge provider's operations from
inspect; the provider's version owns their result shapes. For oats.okf, see
[knowledge.md](knowledge.md#knowledge-operations).

<a id="workspace-model-workspaceapi-2"></a>
## Workspace

Feature `workspace-v2`, `workspaceApi: 2`. Model: [workspaces.md](workspaces.md).

- Each command needs an `oats-local.yaml` found walking up from `--dir`, else
  `E_LOCAL_MISSING {dir, searched}`.
- The workspace is read over Git remotes with the operator's credentials,
  never prompting: `E_REMOTE_UNREADABLE {url, reason: "auth" | "not-found" |
  "network" | "timeout" | "killed" | "cache" | "unknown"}`. `killed` (the
  system killed git, for example out of memory) also carries `signal`.
  `network` is what Git's own text shows to be the network (a host that does
  not resolve, a connection refused, reset or closed, a transport that could
  not reach the remote). A failure whose text shows nothing the kernel
  recognises is `unknown` (0.53.0; it read `network` before), and its message
  then ends with a last-line diagnostic: `cannot read remote <url> (unknown):
  <line>`. Git's words are shown only under the
  [whole-line disclosure rule](workspaces.md#repository-references-in-diagnostics);
  otherwise `<line>` is the contract's fixed Git notice. Permitted text remains
  one line of at most 300 characters with control characters removed. This
  supersedes the earlier rule that a scrubbed Git line was always shown.
  Only stderr supplies this last-line diagnostic. Empty or whitespace-only
  stderr leaves the message at `(unknown)`, without an error-message fallback;
  an output overflow without a stderr line uses a kernel-owned budget notice. Other diagnostic routes'
  existing error-message fallbacks retain the same original-operation context
  and disclosure rule.
  `cache` (OATS 0.33.0) is local: the
  remote cache on this machine could not be written (a git lock still held,
  another oats process still writing it, or a lock file one left when it
  died); `details.cacheDir` and, when known, `details.lock`,
  `details.guard` or `details.holderPid` say which, and the message says
  what to do.
- **How the Desktop reads it** (0.33.0). Of an `E_REMOTE_UNREADABLE` from
  `status` / `workspace status`, the Desktop keeps the `message` (shown as
  given) and only a bounded cause: `details.reason` (matching
  `^[a-z][a-z-]{0,31}$`) and the host of `details.url`. No path, pid, lock,
  `cacheDir` or other detail field crosses to the renderer. `details.url` is a
  display value under the [repository diagnostic contract](workspaces.md#repository-references-in-diagnostics),
  so it may withhold the reference and supply no host; it is not a transport URL.
  It keys only on
  `code` + `details.reason`: `cache` words the roster "OATS cache
  problem" with the message in full; `network` / `timeout` read "Couldn't
  reach <host>"; any other reason, `unknown` among them, keeps the generic
  wording with the message in full. When the
  deployment was observed before, the failed read keeps that observation:
  `/api/panel` serves it with `error` (the message) and `errorCause {code,
  reason, host?}`, and the roster shows it stale instead of empty.
- There is no package approval: declaring a package is the trust decision.
  No payload carries `approvalNeeded`, `approval` or `approved`.
- A **standalone view** is a member repository whose workspace is not read
  (`standalone:` in `oats-local.yaml`, or an unreadable host): its own souls
  plus `oats.core`. Documents then carry `standalone: true`; otherwise the key
  is absent.

### Removed verbs and flags

A removed verb answers, before any namespace can claim it:

```json
{"schemaVersion":1,"ok":false,"error":{"code":"E_UNKNOWN_COMMAND","message":"unknown command \"install\" — removed by the workspace model v2; use oats sync","details":{"removed":"install","replacement":"oats sync"}}}
```

| Removed | Code | Replacement |
|---|---|---|
| `install`, `restore` | `E_UNKNOWN_COMMAND` | `oats sync` |
| `init` | `E_UNKNOWN_COMMAND` | `oats-local.yaml` + `oats sync` |
| `use` | `E_UNKNOWN_COMMAND` | soul.yaml `capabilities:` + workspace defaults |
| `trust` | `E_UNKNOWN_COMMAND` | declaring the package in `packages:` |
| `list` | `E_UNKNOWN_COMMAND` | `oats workspace status` / `oats capabilities` |
| `catalog` | `E_UNKNOWN_COMMAND` | `oats package add <id> <version>` |
| `remove` | `E_UNKNOWN_COMMAND` | `oats package remove <id>` |
| `migrate` | `E_UNKNOWN_COMMAND` | a rebuild |
| `config` | `E_UNKNOWN_COMMAND` | `oats-local.yaml` and `oats-workspace.yaml` |
| `create`, `type` | `E_UNKNOWN_COMMAND` | the soul's `soul.yaml` in its member repository |
| `inject` | `E_UNKNOWN_COMMAND` | the capability's inject in its member repository |
| `prepare` | `E_UNKNOWN_COMMAND` | `oats onboard` / `oats sync`; `oats spawn <soul> --preview` |
| `inspect --request` | `E_UNKNOWN_COMMAND` | `oats onboard / oats sync; oats spawn --preview` |
| `session recompose` | `E_UNKNOWN_COMMAND` (no details) | a re-spawn |
| `readiness --verify-signatures` | `E_BAD_ARGS` | none |
| `sync --approve`, `onboard --approve` | `E_BAD_ARGS` (`details: {flag}`) | none |
| `status --team` | `E_BAD_ARGS` | `oats status` in the deployment |
| `spawn --instance` | `E_BAD_ARGS` | `--purpose` or `--name` |
| `spawn --ephemeral`, `--instructions-file`, `--def-file` | `E_BAD_ARGS` | a soul in a member repository |
| `soul teams --add`, `--remove`, `--default`, `--clear-default` (0.38.0) | `E_BAD_ARGS` (`details: {flag, replacement}`) | `souls:` in `oats-workspace.yaml` |
| `session … --native-record` | `E_BAD_ARGS` | none |

`details.replacement` is the kernel's prose (shortened above): show it, do not
parse it.

<a id="oats-onboard-onboardapi-2"></a>
### `oats onboard`

```text
oats onboard [<dir>] --workspace <repo ref> [--json]
```

Writes `<dir>/oats-local.yaml` (`{schemaVersion: 2, workspace: <ref>}`),
creates `<dir>/agents/`, then runs the `oats sync` body. It creates no soul
and spawns nothing. `<dir>` defaults to the working directory (`--dir` is the
same argument, given once). The ref is checked before anything is written.

```json
{"onboardApi":2,"local":"/w/oats-local.yaml","dir":"/w","agents":"/w/agents","lock":"/w/oats-lock.json",
 "sync":{"syncApi":1,"workspace":{"name":"acme","key":"github.com/acme/agents"},"members":[],"packages":[],"changes":[],"problems":[],"warnings":[]},
 "hosting":{"host":"github.com/acme/agents","hostIsMember":true,"rule":"If any member is private, host oats-workspace.yaml in a private repo …"},
 "next":{"clone":[{"key":"github.com/acme/agents","name":"agents","url":"https://github.com/acme/agents.git","dir":"/w/agents-repo","present":false,"host":true},
                  {"key":"github.com/acme/platform","name":"platform","url":"https://github.com/acme/platform.git","dir":"/w/platform","present":true,"host":false}],
         "spawn":"oats spawn acme-oats-setup-expert --dir /w",
         "souls":["acme-oats-setup-expert","platform-engineer","release-manager"]},
 "listed":true}
```

- `sync` is the full [`oats sync`](#oats-sync) report (abridged above).
  `standalone: true` is present on a standalone view.
- `hosting`: whether the host is itself a member, and the hosting rule (the
  kernel cannot see forge visibility).
- `next.clone[]`: one row per confirmed member (or, standalone, the
  repository itself): `{key, name, url, dir, present, host}`. `dir` is the
  existing clone (the `clones:` entry, else `<dir>/<name>`), else where to
  clone it: `<dir>/<name>`, or `<dir>/agents-repo` for a member named
  `agents`. `url` is `null` when unknown.
- `next.spawn` is a command string, `oats spawn <soul> --dir <dir>
  [--name <instance>]`, naming the workspace's OATS setup expert, else
  `null` (OATS 0.61.0; before it, only a soul named `oats-operator-expert`
  was named). Among the souls onboarding lists (confirmed members', external
  and package souls; standalone, the repository's own), the setup expert is:
  1. the workspace's own soul named `<workspace name>-oats-setup-expert`
     that declares `oats.setup`, where the workspace name is the `name:` of
     `oats-workspace.yaml` (`sync.workspace.name`); a standalone view has no
     workspace name, so this step does not apply there;
  2. otherwise `oats.framework`'s package soul `oats-setup-expert`, when it
     declares `oats.setup`;
  3. otherwise the first soul by name that declares `oats.setup`;
  4. otherwise none: `null`.

  A soul declares `oats.setup` when its own `soul.yaml` names it under
  `capabilities:` as `{ from: … }`, from any source (`package`, `here` or a
  member key); `oats.setup: off` does not count. A soul is never chosen by
  its name alone: a soul named `<workspace name>-oats-setup-expert` or
  `oats-setup-expert` that does not declare `oats.setup` falls through to
  the next step.

  Only the package soul of step 2 gets `--name`: `<workspace
  name>-oats-setup-expert`; `<workspace name>-oats-setup` when a soul of the
  workspace already holds the first name (spawn refuses an instance name that
  is a soul's); none when that is taken too, or when the name would pass the
  64-character instance-name limit. Spawn then names the instance itself;
  onboarding never refuses on a long workspace name. The text output says why
  a name other than the first is suggested. A soul of steps 1 and 3 is
  spawned with no `--name`.

  Only the soul's own declaration is read, not its resolved composition:
  `oats.setup` that reaches a soul only through the workspace's `defaults:`
  is not seen, and a declared `oats.setup` is not checked to resolve. A soul
  whose name another listed soul shares is named so that `oats spawn` finds
  it alone: `<member>/<soul>` or `<package>/<soul>`, else, when two members
  share a repository name, `<member repo key>/<soul>`. The text output's step 3 names
  the same soul, or, with none, the conventional name to add.
  `next.souls` is the first three soul names, sorted.
- `listed` (feature `deployments-list`): `true` once the deployment is on this
  computer's deployments list ([This computer's deployments](#this-computers-deployments-oats-deployments)),
  else `{code, message}` with the list's error (`E_DEPLOYMENTS_*`). A failed
  add never fails the onboard. `--check` lists nothing.
- Errors: `E_BAD_ARGS` (usage, no `--workspace`, a repeated directory, an
  unknown flag), `E_REPO_REF`, `E_ALREADY_ONBOARDED {local, dir}` (this
  directory already has `oats-local.yaml`), `E_ONBOARD_FAILED {dir}`. A
  failure before the workspace was read removes what onboarding created and
  carries `details: {…, dir, rolledBack: true}`; a later failure keeps the
  files and carries `details: {…, dir, local}`.

<a id="this-computers-deployments-oats-deployments"></a>
### This computer's deployments (`oats deployments`)

Feature `deployments-list`. The kernel's per-user list of the deployments on
this computer ([workspaces.md](workspaces.md#this-computers-deployments)).
Every verb runs from anywhere, needs no deployment, takes no `--server`
(`E_BAD_ARGS`) and never routes to another machine. Each runs the first-use
`~/Agents` import before it answers.

```text
oats deployments [list] --json
oats deployments add [<dir>] [--via tui|desktop] --json
oats deployments remove <path> --json
oats deployments import --from desktop <path>... --json
```

Every answer is a closed key set ([Shapes are closed](#scope)):

| Verb | `result` keys, exactly |
|---|---|
| `list` | `deploymentsApi`, `file`, `deployments`, `imports`; each row `path`, `name`, `state`, `addedAt`, `via` |
| `add` | `path`, `added` |
| `remove` | `path`, `removed` |
| `import` | `imported`, `at`, `added` on the first run; `imported`, `at` on every later one |

A key added to any of them later is a contract change: it is announced here
first, and accepted by the readers in `packages/client/deployment-list.mjs`
before a kernel that writes it ships. A change of meaning moves
`deploymentsApi` to 2. A tombstone stays inside the file: its `removed` and
`removedAt` never reach an answer, and a tombstoned row is never listed.

**`list`** (the default verb):

```json
{"deploymentsApi":1,"file":"/home/me/.oats/config/deployments.json",
 "deployments":[{"path":"/home/me/acme","name":"acme","state":"ok","addedAt":"2026-10-19T10:00:00.000Z","via":"onboard"}],
 "imports":{"agents-dir":"2026-10-19T10:00:00.000Z"}}
```

- The answer is exactly these four keys, and each row exactly
  `{path, name, state, addedAt, via}`. A row `remove` took out is never in
  it, and fields of the file the answer does not name never reach it.
- Rows are sorted by `path`. `name` is the last segment of `path`.
- `state`: `ok`, `missing`, `not-a-deployment` or `unreadable`, from
  existence checks only. A row is a suggestion: a client admits the
  deployment again before it serves it.
- `via`: `onboard`, `tui`, `desktop`, `cli`, `import:agents-dir` or
  `import:desktop`, for information only.
- `imports`: the one-time markers as stored (`agents-dir`, `desktop`), each
  the time it ran.

**`add`** lists the deployment at or above `<dir>` (default: the working
directory: the nearest directory whose `oats-local.yaml` is a regular file,
not a link), canonical, and clears a `remove`. → `{"path":"/home/me/acme","added":true}`;
`added: false` when it was listed already, and nothing is written. `--via
tui|desktop` names the client that adds it (default `cli`); any other value is
`E_BAD_ARGS`. Outside every deployment: `E_LOCAL_MISSING {dir}`.

**`remove`** takes the row whose stored path is `<path>` resolved (no walk up,
so a row whose directory is gone can be removed); nothing on disk is touched.
→ `{"path":"/home/me/acme","removed":true}`; `removed: false`, exit 0, when
`<path>` is not listed. The row is kept as a tombstone: nothing but `add` or
`onboard` lists that path again.

**`import --from desktop`** is the Desktop's one-time migration of its own
lists. The first run lists every absolute path given, whatever its state, and
sets `imports.desktop`, in one write →
`{"imported":true,"at":"<marker>","added":["/home/me/acme"]}` (`added`: the
paths it listed; zero paths are accepted). Every later run changes nothing →
`{"imported":false,"at":"<marker>"}`. A relative path is `E_BAD_ARGS` before
anything is written. A path `remove` took out is not listed again.

Errors of every verb: `E_DEPLOYMENTS_INVALID {file, reason}`,
`E_DEPLOYMENTS_VERSION {file, schemaVersion}`, `E_DEPLOYMENTS_BUSY {file, lock}`,
`E_DEPLOYMENTS_WRITE {file}`, `E_DEPLOYMENTS_IMPORT {dir}` ([the messages](workspaces.md#this-computers-deployments)),
and `E_BAD_ARGS`.

### `oats sync`

```text
oats sync [--dir <d>] [--plan] --json
```

Discovers the workspace, confirms membership, resolves `packages:`, writes
`oats-lock.json` (lockfileVersion 3), takes the automations snapshot and
reports. It creates `agents/` if missing.

`--plan` (0.44.0) previews: the same discovery, resolution and report, with
`plan: true`, and nothing written (no lock, no `agents/`, no automations
snapshot; the remote cache fills as any read fills it). `changes[]` is what a
bare `oats sync` would apply, `workspace.lock` the lock it would write, and
`automations` counts what it would snapshot. A flag or a positional `sync` does
not read is refused with `E_BAD_ARGS` (`details: {flag}` or `{argument}`) before
anything is read or written. A kernel before 0.44.0 ignores `--plan` and
applies: gate `sync --plan` on `version` 0.44.0 or later, never by trying.

```json
{"syncApi":1,"automations":{"triggers":3,"schedules":2,"problems":1,"takenAt":"2026-09-26T19:58:09.281Z"},
 "workspace":{"name":"acme","key":"github.com/acme/agents","url":"https://github.com/acme/agents.git","commit":"45b86f64…",
              "observedAt":"2026-09-26T19:58:07.810Z","local":"/w/oats-local.yaml","lock":"/w/oats-lock.json"},
 "members":[{"key":"github.com/acme/tools","name":"tools","commit":"19839f9e…","confirmed":true,"status":"confirmed","detail":null,
             "souls":["tools-expert"],"capabilities":["acme-tools-dev"],"publishes":{"package":"acme.tools","version":"0.4.0"}},
            {"key":"github.com/acme/billing","name":"billing","commit":"8f2c0d1e…","confirmed":false,"status":"no-backlink",
             "detail":"github.com/acme/billing has no oats-membership.yaml","souls":[],"capabilities":[],"publishes":null}],
 "packages":[{"id":"oats.okf","version":"2.1.3","source":"catalog:oats.okf","commit":"ab897841…","integrity":"sha256-bada35…",
              "capabilities":["oats.okf"],"souls":["knowledge-maintainer"]}],
 "changes":[{"id":"oats.okf","from":null,"to":"2.1.3","commit":"ab897841…"}],
 "problems":[],"warnings":[]}
```

- `plan`: `true` on a `--plan` answer, absent otherwise.
- `automations`: counts from the snapshot this sync took.
- `workspace.name` is `standalone:<repo>` on a standalone view.
- `members[]`: `status` is `confirmed | not-listed | no-backlink |
  backlink-elsewhere | cannot-read`, `detail` explains an unconfirmed row.
  `publishes` reports a member's `oats-package/` (informational).
- `packages[]` are the lock rows; `souls` (feature `package-souls`) the
  package souls it records. `changes[]`: `{id, from, to, commit}`, `to: null`
  when a package left.
- `problems[]`: `{code, path, message, repoKey?, …}`, for example
  `E_WORKSPACE_SCHEMA`, `E_REMOTE_*`, `E_SOUL_AMBIGUOUS` (colliding package
  souls), `E_PACKAGE_MISSING` (a standalone catalog gap: `{code, id, reason:
  "no-catalog", catalog, path, message}`), `E_AUTOMATION_SCHEMA` and
  `E_AUTOMATION_DUPLICATE` (with `kind`). A problem never aborts the sync.
- `warnings[]`: `soul-private-ignored {code, soul, repoKey, path, message}`
  for a soul.yaml still carrying `private`; then (0.49.0)
  `hook-event-unsupported {code, capability, path, message}` per hook event a
  listed member capability declares and this kernel does not run
  ([capability warnings](#capability-warnings-hook-event-unsupported-oats-0490)).
- Errors: `E_LOCAL_MISSING`, `E_WORKSPACE_SCHEMA {path, problems}`,
  `E_REMOTE_UNREADABLE`, `E_LOCK_SCHEMA`, `E_PACKAGE_MISSING`,
  `E_PACKAGE_INTEGRITY`, `E_PACKAGE_MANIFEST`, `E_REPO_REF`, `E_BAD_ARGS`.
  `E_PACKAGE_INTEGRITY` names its case in `details.why`: `branch`,
  `package-id`, and `capabilities` or `souls` for an edited lock; a tag or
  content that moved carries none
  ([`oats sync`](packages.md#oats-sync--the-one-command-for-the-common-path)).
  The Desktop's sync sheet words the refusal per `why`, and gives no `why`, or
  one it doesn't know, the code's general meaning; its Details show the
  kernel's message.

### `oats package add` and `remove`

```text
oats package add <id> <version | git:<repo>@<ref>> [--dir <d>] --json
oats package remove <id> [--dir <d>] --json
```

Edits `packages:` only when `oats-workspace.yaml` is tracked by the checkout
found from `--dir`; otherwise it reports the change to make.

```json
{"action":"add","id":"oats.aweb","value":"v1.17.1","previous":null,"edited":true,"file":"/w/agents-repo/oats-workspace.yaml"}
```

```json
{"action":"add","id":"oats.aweb","value":"v1.17.1","edited":false,"file":null,"line":"packages:\n  oats.aweb: v1.17.1","hint":"oats-workspace.yaml is not in this checkout; commit the change in the workspace repo, then `oats sync`"}
```

`remove` answers `value: null` (and `line: null` when not tracked). An id that
is not declared is `E_PACKAGE_MISSING {id, …}`; an untracked `remove`
discovers the workspace over the network to check. Other errors: `E_USAGE`,
`E_WORKSPACE_SCHEMA` (a bad id or value), `E_REPO_REF`.

### `oats workspace status`

```text
oats workspace status [--dir <d>] [--max-age <s>] --json
```

Read-only (it writes no lock):

```json
{"workspaceStatusApi":1,
 "workspace":{"name":"northwind","key":"github.com/nw/agents","url":"https://github.com/nw/agents.git","commit":"66566512…",
              "observedAt":"2026-09-28T10:07:51.783Z","local":"/w/oats-local.yaml",
              "teams":[{"label":"eng","team":null,"description":"Platform engineering"},{"label":"oats","team":"oats:oats.aweb.ai","description":"The OATS project"}],
              "file":{"path":"oats-workspace.yaml","url":"https://github.com/nw/agents/blob/66566512…/oats-workspace.yaml"}},
 "members":[{"key":"github.com/nw/agents","name":"agents","commit":"66566512…","confirmed":true,"status":"confirmed","detail":null,
             "souls":["rm"],"capabilities":["nw-house-style"],"publishes":null,"url":"https://github.com/nw/agents/tree/66566512…",
             "membershipFile":{"path":"oats-membership.yaml","url":"https://github.com/nw/agents/blob/66566512…/oats-membership.yaml"}}],
 "packages":[{"id":"oats.okf","version":"3.0.0","source":"catalog:oats.okf","commit":"ab897841…","integrity":"sha256-bada35…",
              "capabilities":["oats.okf"],"souls":[],"latest":{"version":"4.1.1","ref":"v4.1.1"}}],
 "declaredPackages":["oats.framework","oats.okf"],"unsynced":["oats.framework"],"stale":[],
 "external":[{"source":"git:github.com/oss/experts@3c606e09…","soul":"security-reviewer"}],
 "problems":[],"warnings":[],
 "automations":{"host":"ana-laptop","snapshot":{"takenAt":"2026-09-28T10:00:00.000Z","problems":0},
                "rows":[{"kind":"schedule","id":"agents/nightly","runsOn":"ana-laptop","owner":"github.com/ana","runsHere":true,"reason":null,"enabledHere":true,
                         "origin":{"kind":"workspace","repoKey":"github.com/nw/agents","path":"oats-schedules/nightly.yaml","commit":"66566512…","url":null,"localPath":null}}]},
 "defaults":{"slots":{"knowledge":{"name":"oats.okf","from":"package"},"messaging":"none","tasks":null},
             "capabilities":[{"name":"oats.core","from":"package","off":false}]},
 "clones":[{"key":"github.com/nw/agents","name":"agents","path":"/w/agents-repo","rule":"convention"}],
 "disabledSouls":[],"lock":{"path":"/w/oats-lock.json","lockfileVersion":3}}
```

- `members[]` and `packages[]` are the sync rows (packages from the lock).
- **Remote budget (0.33.1).** `oats workspace status` and `oats status` finish
  their remote work within 12 s of their first remote read, whatever the
  machine's load or another process holding a remote's cache. A member not
  read by then is a `cannot-read` row whose `detail` ends `(timeout)`, and its
  git is ended; the command still answers. The workspace definition itself
  (the host) not read by then fails the command as any unreadable host does
  (`E_REMOTE_UNREADABLE`, `reason: "timeout"`). Spawn, sync and every other
  verb have no such budget.
- `declaredPackages`: the ids in `packages:` (standalone: the kernel's
  default). `unsynced`: declared, not locked. `stale`: locked, no longer
  declared. `external[]`: `{source, soul}`.
- `workspace.teams` (feature `team-model-3`): the shared teams `{label, team,
  description}` by label; `[]` standalone.
- `problems`, `warnings`: as in sync.
- `automations` (feature `automations`): `{host, snapshot: {takenAt,
  problems (a count)} | null, rows: [{kind, id, runsOn, owner, runsHere,
  reason, enabledHere, origin, invalid?}]}`.
- Automation trust (0.30) adds to `warnings`:
  - `{code: "automation-untrusted", kind, id, message, remedy}` for each row
    whose reason is `untrusted`. `remedy` is the `oats-local.yaml` line.
  - `{code: "automation-trust-stale", entry, message}` for a trust entry that
    names no workspace trigger or schedule (a member may not have synced yet).
- The rest are [Desktop facts](#desktop-facts-feature-desktop-facts-oats-0290).

<a id="oats-capabilities---dir---json--capabilitiesapi-1--oats-souls---dir---json--soulsapi-1"></a>
### `oats capabilities` and `oats souls`

```text
oats capabilities [--dir <d>] [--max-age <s>] --json
oats souls [--dir <d>] [--max-age <s>] --json
```

Every item of every confirmed member, the external souls, and the locked
packages' capabilities and souls, sorted by name, then origin. Both carry
`workspace: {name, key, commit}`, `problems` and, on a standalone view,
`standalone: true`. Text mode prints every `problems` row on stdout under
the table, in the same order as JSON: discovery problems, then unmatched
`souls.launch` keys for `oats souls`. The line is `! <code>: <message>`,
preserving the kernel code and message. A row with an owner (`repoKey`,
`package` or `source`) adds ` [<where>]`: its existing `path`, preceded by
`repoKey: ` or `package: ` when present. A source-owned row shows its diagnostic
source display followed by its path; the source uses the shared
[repository-reference display policy](workspaces.md#repository-references-in-diagnostics)
and may be withheld as a whole. Operational external sources remain exact. Context uses
the kernel's terminal text escaping. Ownerless rows, including unmatched
launch keys, have no bracket. Partial listings still exit 0; JSON success
semantics and fatal refusals are unchanged. A problem does not necessarily
mean an item is absent from the table.

```json
{"soulsApi":1,"workspace":{"name":"northwind","key":"github.com/nw/agents","commit":"66566512…"},
 "souls":[
   {"name":"writer","origin":"member github.com/nw/mkt @ 46b3494a","kind":"member","repoKey":"github.com/nw/mkt","commit":"46b3494a…",
    "teams":[{"label":"mine","team":"mine:ana.aweb.ai","default":true,"from":"local"},{"label":"global","team":null,"default":false,"from":"shared"}],
    "defaultTeam":{"label":"mine","team":"mine:ana.aweb.ai","from":"deployment"},
    "private":false,"path":"souls/writer","work":"directory","description":"Drafts campaigns.","harness":"pi","model":null,"harnessFrom":"kernel-default",
    "file":{"path":"souls/writer/soul.yaml","url":null},"spawnable":true,"problem":null,
    "capabilities":[{"name":"oats.aweb","kind":"package","package":"oats.aweb","from":"workspace"}]},
   {"name":"knowledge-maintainer","qualifiedName":"oats.okf/knowledge-maintainer","origin":"package oats.okf v4.1.1","kind":"package","package":"oats.okf",
    "version":"4.1.1","repoKey":"github.com/awebai/oats-okf","commit":"e1d604f7…","teams":null,"defaultTeam":null,"private":false,
    "path":"oats-package/souls/knowledge-maintainer","work":"directory","description":"Reviews harvested knowledge.","harness":"pi","model":null,
    "harnessFrom":"kernel-default","file":{"path":"oats-package/souls/knowledge-maintainer/soul.yaml","url":null},
    "spawnable":false,"problem":{"code":"E_TEAM_UNKNOWN","message":"team \"reviewers\" is not declared (oats-local.yaml#/defaultTeam): …"},
    "capabilities":null}],
 "problems":[]}
```

**Capability rows:** `name`, `origin` (display text), `kind`, then for a
member `repoKey, commit, private, path, layer, version`, for a package
`package, version, commit, private: false, layer`; plus the Desktop facts
`description, skills, commands, hooks, file, tree`. `private: true` (feature
`capabilities-private`) marks a capability usable only by its own repository's
souls (`E_CAPABILITY_PRIVATE` otherwise). An unsynced package's capabilities
are absent until `sync`.

**Soul rows:** `name, origin, kind (member | external | package), repoKey,
commit, teams, defaultTeam, private (always false), path, work, description`,
plus the Desktop facts `harness, model, harnessFrom, file, spawnable,
problem`, (feature `souls-capabilities`) `capabilities`, (feature
`launch-preference`) `key` and `launch`, and (feature `instance-background`)
`background: true` on a soul whose `soul.yaml` says `background: true`,
absent otherwise: the launch dialog's default for Run in background.
- `key` is the soul key that `souls.launch` uses, and that
  `oats soul teams <key>` takes: `qualifiedName` for a package
  soul, the bare `name` for a member or external soul. Two member souls that
  share a bare name share one entry (spawning that name is
  `E_SOUL_AMBIGUOUS`).
- `launch` is a [Launch](#the-launch-report-launch).
- **`problems` rows for `souls.launch`** (0.53). `oats souls` adds, after the
  read's own rows, one row per key of `souls.launch` that names no soul:
  `{code: "E_LAUNCH_PREFERENCE_UNMATCHED", path, message, key, value,
  suggestions}`, sorted by key. `path` is where the key is
  (`oats-local.yaml#/souls/launch/<key>`), `key`, `value` and `suggestions`
  as in the refusal's `details.keys`. `message` is at most 1024 characters
  and ends with the two commands, in their order. Each soul a spawn would
  refuse carries the refusal as `launch.problem`: the souls with no entry of
  their own.
- `teams` and `defaultTeam` (feature `team-model-3`) are a
  [TeamRow](#the-team-row-teamrow) list and a
  [DefaultTeam](#the-default-defaultteam); both `null` when the soul's teams
  do not resolve (`problem` names the `E_TEAM_*` code).
- `capabilities` (feature `souls-capabilities`, OATS 0.45.0): what the soul's
  resolution composes, slots and additive alike, sorted by `name`. Each entry
  names its capability with the capability row's own keys: `name`, `kind`
  (`member` | `package`), then `repoKey` for a member or `package` for a
  package, so it matches exactly one `oats capabilities` row. `from` is why
  the soul has it: `soul` (it declares it) or `workspace` (a workspace
  default), as in inspect's `layers.<slot>.from`. A capability the soul
  turned off (`off`, or `<slot>: none` over a workspace default) is not
  listed. `null` whenever `spawnable` is false (`problem` names why),
  including a soul disabled on this machine; never `[]` for unknown.
- Package souls (feature `package-souls`) add `qualifiedName`
  (`<package>/<soul>`), `package` and `version`. Spawn one by
  `qualifiedName` (the bare name when unique). Its instances live under
  `agents/<package>--<soul>/` with `.` written `-` (for example
  `oats-okf--knowledge-maintainer`), which is its agent `name` in the roster.

This document keeps `soulsApi: 1`; the probe's `soulsApi: 2` is the inspect
soul row's.

### `oats capabilities show`

Feature `capability-show`, `capabilityShowApi: 1`, OATS 0.34.0.

```text
oats capabilities show <name> [--member <repoKey> | --package <id>] [--dir <d>] [--max-age <s>] --json
oats capabilities show <name> [--member <repoKey> | --package <id>] --file <path> [--dir <d>] [--max-age <s>] --json
```

What one capability ships: its inject text and each skill's files, and one
file's text on request. The Desktop's capability page shows them without
reading clones or caches itself.

> **Every `text` and `description` is untrusted repository content.** Render
> it as plain text (`textContent`), or through a sanitising Markdown renderer
> that allows no raw HTML, no scripts and no remote images.

**Selection.** The rows are exactly the rows of `oats capabilities --json`
(one discovery, honouring `--max-age`), so the answer's `commit` equals that
row's `commit`.

- `<name>` alone selects the one row with that name.
- `--member <repoKey>` selects a member row of that repository: the key as a
  row shows it, or any ref spelling of the same repository.
- `--package <id>` selects that package's row.
- No row: `E_CAPABILITY_UNKNOWN`, `details: {name}` plus `member` or
  `package` when one was given. An unsynced package is not in the catalog, so
  its capabilities are `E_CAPABILITY_UNKNOWN` until `oats sync`.
- More than one row: `E_CAPABILITY_AMBIGUOUS`, `details: {name, candidates}`,
  each candidate `{kind, repoKey, origin}` (member) or `{kind, package,
  origin}` (package). Choose one with `--member` or `--package`.
- `E_BAD_ARGS` for `--member` with `--package`, a missing or second name, an
  unknown flag, and `--server` (the verb reads this machine's workspace only).
  An unknown word after `oats capabilities` (`oats capabilities foo`) is
  `E_BAD_ARGS` too.

**Trust path.** Every read goes through the remote cache at a full commit id;
nothing reads a working clone.

- A member capability is read from its member repository at the row's commit.
- A package capability is read at the locked commit, the same trust path
  spawn uses. First comes spawn's lock check: when the package manifest at
  that commit does not list the capability, or its capability list differs
  from the lock's, the show refuses `E_PACKAGE_INTEGRITY` with spawn's
  details. The full-tree content digest is not recomputed per show: `oats
  sync` proved the lock's integrity over the tree of exactly that commit, and
  the commit id content-addresses the tree.

**The show:**

```json
{"capabilityShowApi":1,"name":"oats.okf","kind":"package","repoKey":"github.com/awebai/oats-okf","package":"oats.okf","version":"4.1.1",
 "commit":"e1d604f7…","path":"oats-package/capabilities/oats-okf",
 "inject":{"path":"injects/okf.md","bytes":2422,"text":"## Knowledge: OKF\n\nYou have two kinds of knowledge. …","binary":false,"truncated":false},
 "skills":[{"name":"okf-consultation","path":"skills/okf-consultation","description":"Consulting your soul's knowledge with the `oats okf` CLI: …",
            "files":[{"path":"skills/okf-consultation/SKILL.md","bytes":6947},{"path":"skills/okf-consultation/references/consult.md","bytes":4465}],
            "filesTruncated":false},
           {"name":"okf-instance-knowledge","path":"skills/okf-instance-knowledge","description":"Keeping this instance's own knowledge …",
            "files":[{"path":"skills/okf-instance-knowledge/SKILL.md","bytes":4787}],"filesTruncated":false}],
 "problems":[]}
```

- `kind` is `member` or `package`. `repoKey` is set for both kinds; for a
  package it is the repository the package is read from. `package` and
  `version` are the package id and locked version, `null` for a member.
- `commit` is 40 hex and equals the catalog row's `commit`. `path` is the
  capability directory, repository-relative.
- `inject` is `{path, bytes, text, binary, truncated}` or `null`. `skills`
  is a list of `{name, path, description, files, filesTruncated}`, each file
  `{path, bytes}`, or `null`. `problems` is a list of `{code, message,
  path}`.
- `warnings` (0.49.0) is always present, on the show and the `--file`
  answer: the capability's
  [capability warnings](#capability-warnings-hook-event-unsupported-oats-0490).
  Their `path` is the repository-relative form, unlike the paths above. The
  text form prints them (to stderr with `--file`).
- `triggerSources` (feature `trigger-sources`), after
  `warnings`, only when the manifest declares the key: the declaration
  exactly as written, whatever its shape (untrusted text: render it as
  text). `triggerSourceProblems: [{source, pointer, message}]` follows only
  when the declaration has problems: the ones a trigger naming a source
  would get as `E_TRIGGER_SOURCE`, `source` `null` for a top-level problem,
  `pointer` a JSON pointer into the manifest. A malformed declaration never
  refuses the command and adds nothing to `problems`
  ([capabilities.md](capabilities.md#trigger-sources-triggersources)).
- With `--max-age` (`0` included) both the show and the `--file` answer gain
  the [`observation`](#observation-reuse-feature-observe-max-age-oats-0311)
  block `{observedAt, reused, localRevision}`.

**The `--file` answer:**

```json
{"capabilityShowApi":1,"name":"oats.okf","kind":"package","commit":"e1d604f7…",
 "file":{"path":"skills/okf-instance-knowledge/SKILL.md","bytes":4787,"text":"---\nname: okf-instance-knowledge\n…","binary":false,"truncated":false}}
```

**Rules.**

- **Paths.** Every `path` in `inject`, `skills`, `file` and `problems` is
  POSIX and relative to the capability directory, never the repository.
  Every non-null `path` is a safe relative path: no `.`, `..` or `.git`
  component (any case), no empty component, no `\`. A manifest's inject and
  skill paths are reported as the module install reads them: a `\` is a
  separator, and a leading `./` and trailing slashes are dropped
  (`injects\guide.md` is `injects/guide.md`).
- **The inject** is the committed file exactly: untrimmed and untemplated.
  (Spawn composes it raw and trimmed, with no settings substitution.)
  - `inject: null`: the manifest declares no inject.
  - Declared but unreadable (missing, a symlink, a directory, over the read
    budget): `inject: {path, bytes: null, text: null, binary: false,
    truncated: false}` and a `problems[]` entry with the remote's code
    (`E_REMOTE_PATH_MISSING`, `E_REMOTE_TREE_UNSAFE`, `E_REMOTE_FILE_OVERSIZE`,
    …). The show still answers ok.
  - Declared as a path that is not a safe relative path (spawn refuses it):
    `inject: {path: null, bytes: null, text: null, binary: false, truncated:
    false}` and a problem with spawn's code (`E_CAPABILITY_MISSING` for a
    member, `E_PACKAGE_MANIFEST` for a package) and `path: null`. The raw
    manifest value appears only inside `message`, JSON-quoted. So
    `inject.path` is `null` only with a problem.
- **Skills** are in the catalog row's order (by name, in codepoint order),
  enumerated exactly as a spawn enumerates them. `skills` is `null` exactly
  when the catalog row's `skills` is `null`, with a problem carrying spawn's
  code (`E_CAPABILITY_MISSING` or `E_PACKAGE_MANIFEST`) or an `E_REMOTE_*`
  code, and `path: null`. A skill whose path is not safe (a `.git`
  directory) makes the skills unlistable the same way, in both answers.
- **Files.** `files` is every regular file under the skill directory,
  recursively (no symlinks, no submodules), sorted by path in codepoint order.
  At most 200 per skill; beyond that `filesTruncated` is `true`. `bytes` is
  the blob size. When a skill's files cannot be listed (an unsafe entry name
  in the tree, an unreadable remote), `files` is `null`, `filesTruncated` is
  `false`, and a problem's `path` is the skill's `path`: "could not list"
  never collapses into "listed nothing".
- **`description`** is the `description` key of SKILL.md's leading `---` YAML
  front matter, when it is a string. It is parsed from the whole SKILL.md,
  not from its 262144-byte text cut. It is `null` when the front matter is
  absent or does not parse, the key is absent or not a string, or SKILL.md is
  unreadable or binary (no problem is reported for it). It is cut to at most
  1024 UTF-8 bytes on a code point boundary.
- **Text.** A file is `binary: true, text: null` when it contains a NUL byte
  or is not valid UTF-8. Only the first 262144 + 3 bytes are examined, so the
  cut is decided on the same bytes; when the file is longer, a valid sequence
  they end inside of is not held against it. Otherwise `text` is the content cut to at
  most 262144 UTF-8 bytes on a code point boundary, with `truncated: true`
  when cut. A byte order mark is kept in the text. `bytes` is always the real
  size.
- **Invariants** (pinned for the Desktop):
  - `binary: true` ⇒ `text: null` and `truncated: false` (`truncated` is a
    text-only flag).
  - `truncated: true` ⇒ `text` is a string and `binary: false`.
  - `bytes` is `null` only for an unreadable declared inject (with its
    problem). In a `--file` answer it is always an integer.
- **Large files.** A file over the read budget (4 MiB) is listed with its
  size. `--file` refuses it with `E_REMOTE_FILE_OVERSIZE`, passed through
  unchanged: its `details.path` is repository-relative, not
  capability-relative.

**`--file <path>`** reads one file the show lists, and nothing else.

- A syntactically unsafe path is `E_CAPABILITY_FILE_UNSAFE`, `details:
  {path}`, before anything is read: absolute, empty, a `.`, `..` or `.git`
  component (any case), an empty component, a trailing slash, a `\` or a NUL.
- Otherwise the path must be the inject's `path` or a path in some skill's
  `files` as the show lists it (the 200 cap included). Anything else is
  `E_CAPABILITY_FILE_UNKNOWN`, `details: {path, name}`. No other file of the
  capability (`oats.json`, scripts, `bin/`) is readable through this verb.
- A file the show does not list (beyond the 200 cap, a symlink, under a skill
  whose files cannot be listed) is `E_CAPABILITY_FILE_UNKNOWN` by design:
  show "not available", not an error.
- A listed file the remote cannot read answers the remote's own code
  (`E_REMOTE_FILE_OVERSIZE`, `E_REMOTE_PATH_MISSING`, `E_REMOTE_TREE_UNSAFE`,
  …).

**Failures.** Every failure is exactly one error envelope on stdout with a
nonzero exit, as for every command: `E_BAD_ARGS`, `E_CAPABILITY_UNKNOWN`,
`E_CAPABILITY_AMBIGUOUS`, `E_PACKAGE_INTEGRITY`, `E_CAPABILITY_FILE_UNSAFE`,
`E_CAPABILITY_FILE_UNKNOWN`, an `E_REMOTE_*` code, and the workspace's own
(`E_LOCAL_MISSING`, `E_LOCK_SCHEMA`, …).

**Without `--json`** the show prints a short listing for an operator: the
inject's path and size, each skill with its files and sizes, the trigger
sources (name, command, events, description) and their problems, and the
problems. `--file` prints the text; a binary file prints a one-line note
instead, and a truncated file prints its text followed by a one-line note.

<a id="desktop-facts-feature-desktop-facts-oats-0290"></a>
### Capability warnings (`hook-event-unsupported`, OATS 0.49.0)

A capability may declare a hook event this kernel does not run (a newer
kernel's). It composes, the event never runs, and each answer that shows the
capability carries one warning per such event
([capabilities.md](capabilities.md#manifest)):

```json
{"code":"hook-event-unsupported","capability":"acme.tool",
 "path":"github.com/acme/agents:capabilities/acme-tool/oats.json#/hooks/on-merge",
 "message":"capability acme.tool declares hook \"on-merge\", which this kernel does not run; it is ignored (this kernel runs soul-scaffold, spawn, retire, launch, worktree)"}
```

| Answer | Where | Covers |
|---|---|---|
| `oats sync`, `oats workspace status` | `warnings[]`, beside `soul-private-ignored` | every listed member capability |
| `oats capabilities show` (and `--file`) | `warnings[]`, always present | the capability shown |
| `oats inspect`, `oats readiness` | `warnings[]`, always present | `--soul`: the soul's resolved modules; `--home`: the home's module copies |
| `oats doctor --json` | `warnings[]` | `--soul`: the soul's resolved modules; without it, every member capability and every locked package's, from this machine's cache |
| `oats spawn --preview`, `oats spawn` | `warnings[]`, strings | the message of each, for the soul's resolved modules, each at most 1000 characters and at most 32 lines (past that, one line naming how many more); a same-key replay answers them from the home's module copies |

`path` is never an absolute host path. It is `<repoKey>:<dir>/oats.json#<pointer>`
for a member capability, `package:<id>:<dir>/oats.json#<pointer>` for a
package capability (`<dir>` relative to the repository), and, for `--home`,
`.oats/modules/<name>/oats.json#<pointer>`, relative to the home: the copy
actually read. Without `--soul`, doctor reads only this machine's cache; what
it cannot answer is one `information[]` line `hook-events-unchecked: <member
capabilities | package <id>'s capabilities> were not checked …`, never an
empty list read as "no warning". Older kernels answer no such `warnings` key
(inspect, readiness, show, doctor) and refuse the capability instead.

`oats doctor --json` also lists what retires left behind in `information[]`:
one `retained-recovery:` and one `retained-worktree:` line per item, after a
line that gives each kind's total, and at most 50 items per kind
([After a retire](souls-and-instances.md#after-a-retire-inspect-restore-dispose)).
Each element is one line of text with no newline. The answer has no new key.

`oats doctor --json` lists each retirement left open as one
`retire-incomplete` problem in `problems[]`, `{code, message, remedy}`
(oats-project/oats#1747). Text prints it as `! retire-incomplete: <message>`
with the remedy on the next line. A retirement is open when the home reads
quarantined (`rollbackIncomplete`), when its self-retire is `failed` or
`interrupted`, or when a failed self-retire left its outcome beside a home
that is still there. A home whose retire is `running` or `unknown`, a spawn
in progress, and an outcome whose home is gone are not listed. The message
names the instance, the home, what is open and since when. The remedy is
`oats retire <name> --home <home>`, each word quoted for a shell, and names
the capability whose retire hook failed last, or says that none is recorded.
Doctor reads this as `oats status` does, offline and read-only. Its exit
status does not change: doctor exits 0 with problems. A deployment with no
open retirement sees no change.

`oats doctor --json` lists this machine's session resume lock, when it needs a
person, as one `resume-lock-stuck` problem in `problems[]`, `{code, message,
remedy}` ([The machine sweep](#the-machine-sweep-oats-session-resume),
`E_RESUME_LOCK_STUCK`). It is the machine's, the same from every deployment.

### Desktop facts

Feature `desktop-facts`: facts the kernel reports so the Desktop never derives
them. Gate each field below on it.

| Document | Fields |
|---|---|
| `oats inspect --soul` | `capabilities[].composedFrom`, `capabilitiesOff[]` |
| `oats souls` rows | `harness`, `model`, `harnessFrom`, `spawnable`, `problem`, `file` |
| `oats capabilities` rows | `layer`, `description`, `skills`, `commands`, `hooks`, `file`, `tree` |
| `oats workspace status` | `workspace.file`, `members[].url`, `members[].membershipFile`, `packages[].latest`, `defaults`, `clones`, `disabledSouls`, `lock` |
| `oats status` instance rows | `startedAt`, `modelFrom`, `identityAddress`; `modules[].current.version` on member rows |

- **Souls.** `harness`, `model`, `harnessFrom`: what a spawn starts with when
  no selection flag is given, else `harness: "pi"`, `model: null`,
  `harnessFrom: "kernel-default"` (`"soul"` when the definition names one; a
  v2 soul.yaml cannot). `spawnable`/`problem`: whether a spawn here would
  refuse, resolved without spawning, writing or reaching past the sync cache;
  `problem` is `{code, message}` or `null` (`E_SOUL_DISABLED`,
  `E_TEAM_UNKNOWN`, `E_WORKSPACE_SCHEMA` (local-teams-closed), `E_CAPABILITY_*`, `E_PACKAGE_*`,
  `E_LOCK_SCHEMA`, `E_REMOTE_*`, …). `file`: `{path, url}` of soul.yaml.
- **Capabilities.** `layer` on every row, `null` outside the slots.
  `description` or `null`. `skills`, `commands`, `hooks`: names, sorted
  (`skills` is `null` when they cannot be listed). `file`: `{path, url}` of
  `oats.json`, or `null` when unreadable. `tree`: a member capability's Git
  tree id at the member commit; `null` for a package (its fingerprint is the
  lock's `integrity`). Package facts are read from the sync cache; unreadable
  manifests leave them `null`.
- **`defaults`**: the workspace file's defaults as declared. `slots.<slot>` is
  `{name, from}`, `"none"` or `null`; `capabilities` are `{name, from, off}`
  by name (`from` is `"package"`, `"here"` or a member key; `null` when off).
  Standalone: every slot `null`, `capabilities: []`.
- **`clones[]`**: `{key, name, path, rule}` with `rule` `"clones"`,
  `"convention"` or `null`. A path that is not the member's clone gives
  `path: null, rule: null, problem: {code: "E_CLONE_MISMATCH", message}`.
- **`disabledSouls`**: `souls.disabled` as written. **`lock`**: `{path,
  lockfileVersion}`.
- **`packages[].latest`**: `{version, ref}` when the kernel's bundled catalog
  has a newer version of a catalog package; `null` otherwise and for `git:`
  packages. No network (`OATS_PACKAGE_CATALOG` overrides the catalog).
- **`workspace.file`**, **`members[].url`**, **`members[].membershipFile`**:
  `{path, url}` at the named commit (`workspace.file` is `null` standalone).
- **URLs** exist only for `github.com` (`…/blob/<commit>/<path>` or
  `…/tree/<commit>`); any other host gives `url: null` with `path` set.
  `path` is repository-relative.

<a id="team-model-3-feature-team-model-3-oats-0370-replaces-feature-team-model-2"></a>
<a id="team-model-v2-feature-team-model-2-oats-0300-replaces-feature-teams"></a>
## Teams

Feature `team-model-3` (OATS 0.38.0; it replaces `team-model-2`): gate every
team field and verb on it. Design: [team model 3](design/2026-10-02-team-model-3.md);
operator guide: [workspaces.md](workspaces.md#teams).

- **The workspace file** (`oats-workspace.yaml`, committed) holds the shared
  teams `teams.<label> = {description?, team?}` (a shared team without `team`,
  the provider id, is **unmapped**), `defaultTeam: <label>` (the workspace's
  fallback default), `localTeams: true|false` (absent: false) and `souls:`
  (per pattern, `{default?, teams?: [labels] | "any"}`). Every label there is
  a shared label of that file; anything else is `E_WORKSPACE_SCHEMA` when the
  file is read.
- **`oats-local.yaml`** may declare local teams `teams.<label> = {team,
  description?}` and `defaultTeam: <label>` only where the workspace says
  `localTeams: true`, or in the standalone view (no workspace file is read).
  Elsewhere they are refused: `E_WORKSPACE_SCHEMA` with details `{reason:
  "local-teams-closed", path: "oats-local.yaml", keys}`, the message naming
  both fixes. `souls.teams` and `souls.default` are removed keys
  (`E_WORKSPACE_SCHEMA`, reason `removed-key`): the refusal names each key
  found, and `details.replacement` is the `souls:` YAML to commit instead (a
  bare soul name written `<member>/<soul>` for the operator to qualify), also
  printed at the end of the message. Every command that reads the file
  refuses, an instance home's messaging commands, operations, `inspect --home`
  and `readiness --home` included: they never fall back to the home's
  recorded teams for it. A home's other capability commands read only the
  home's own record, as always.
- **A soul's key** is its qualified name: `<package>/<soul>`, or
  `<member>/<soul>` with the member repository's name (as `souls.disabled`
  names it). A label matches `[a-z0-9][a-z0-9._-]*` and is at most 64
  characters (0.44.0). A longer one is refused: `E_WORKSPACE_SCHEMA` in
  either file, `E_BAD_ARGS` from `oats teams add`, and `E_TRIGGER_INVALID`
  (`field: spawn.teams`) in a trigger.
- **Team ids.** A `team` value (in either file, and `oats teams add --team`)
  matches `^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$`: the kernel's safety rule
  (never `-`-led, no whitespace or control characters, bounded). Otherwise
  `E_WORKSPACE_SCHEMA` (a file) or `E_BAD_ARGS` (the verb). The messaging
  provider validates its own id shape (oats.aweb: `<name>:<namespace>`).
- **Resolution.** The `souls:` patterns for a soul are its key, then
  `<member|package>/*`, then `"*"`. The most specific one that exists gives
  the soul's teams outright (lists never merge); the most specific one that
  sets `default` gives its default. So `a/*: {default: security}` and
  `a/x: {teams: [docs]}` give `a/x` the default `security` and the teams
  `[docs]` only. The default is that `default`; else the local `defaultTeam`
  where local teams are allowed; else the workspace's `defaultTeam`; else
  none. A soul's teams are its default, its pattern's `teams` (`any`: every
  shared team) and, where local teams are allowed, every local team. A soul
  no pattern matches has its default only. A label in both files is a
  `team-label-collision` warning, and the shared definition wins. A local
  default no file declares is `E_TEAM_UNKNOWN`.
- **Removed keys** are `E_WORKSPACE_SCHEMA` with `reason: "removed-key"`:
  `oats-local.yaml` `souls.teams` and `souls.default` (0.38.0);
  `messaging.byTeam`, `defaults.byTeam`, a soul.yaml `team`, an
  oats-membership.yaml `team`, and `byTeam` in any provider payload layer
  (0.30). Other payload keys are opaque (a `team` setting passes through).

### The team row (`TeamRow`)

Exactly `{label, team, default, from, via}`:

```json
[{"label":"security","team":"security:acme.aweb.ai","default":true,"from":"shared","via":["default"]},
 {"label":"docs","team":null,"default":false,"from":"shared","via":["workspace"]},
 {"label":"mine","team":"mine:ana.aweb.ai","default":false,"from":"local","via":["local"]}]
```

`team` is `null` for an unmapped team. `default` is true on exactly the
soul's default row; the others are teams an instance may join (offered, never
joined automatically). `from` is where the label is defined: `"shared"` or
`"local"`. `via` is why the soul may join it, an ordered non-empty subset of
`"default"`, `"workspace"` (its `souls:` pattern) and `"local"` (a local team
where local teams are allowed). The default row comes first, then the rest by
label (codepoint order). Reports include unmapped rows; `OATS_TEAMS` and
`instance.json.teams` carry mapped rows only. A home spawned before 0.38.0
recorded rows without `via`, and they are reported as recorded.

### The default (`DefaultTeam`)

```json
{"label":"security","team":"security:acme.aweb.ai","from":"soul"}
```

`from` is `"soul"` (the soul's `souls:` default in the workspace file; before
0.38.0 it meant `oats-local.yaml` `souls.default`), `"deployment"` (the local
`defaultTeam`) or `"workspace"` (the workspace's `defaultTeam`). It is `null`
only when no default is configured (with messaging active, that is
`E_TEAM_UNCONFIGURED`). An unmapped default is `{label, team: null, from}`,
the blocking problem `team-unmapped`.

<a id="where-teams-appear"></a>
### Where teams appear

| Document | Team fields |
|---|---|
| `oats spawn … --preview` | `teams` (unmapped included), `defaultTeam` |
| `oats inspect --soul` | `teams`, `defaultTeam`, `teamsSource: "live"` |
| `oats inspect --home` | `teams`, `defaultTeam`, `teamsSource` (`"live"`, or `"recorded"` when the workspace cannot be read; `teams: null` when none was recorded), `recordedDefaultTeam` |
| `oats readiness` | items under `checks.configured` |
| `oats souls` rows | `teams`, `defaultTeam` (`null` when they do not resolve) |
| `oats workspace status` | `workspace.teams` |
| `instance.json` | `teams` (mapped rows), `defaultTeam` |

A home's live teams are the files as they are now; a running instance keeps
its spawn-time default until respawned (readiness says so with
`default-team-changed`). No document carries a soul-level `team`, `labels`,
`primary`, `mapped` or `byTeam`, and no capability origin is `team:<label>`.

**Provider environment.** Hooks, commands, operations and provider checks get
the teams in `OATS_DEFAULT_TEAM`, `OATS_DEFAULT_TEAM_ID`,
`OATS_DEFAULT_TEAM_FROM`, `OATS_TEAMS` and `OATS_TEAMS_SOURCE`:
[capabilities.md](capabilities.md#teams-in-the-provider-environment).
`OATS_TEAMS` is exactly the soul's eligible mapped rows, so a provider that
admits joins from it refuses any other team. `OATS_WORKSPACE_NAME` is the
recorded workspace name (the discovered one for a soul subject), `""` when
unknown.

<a id="oats-teams"></a>
### `oats teams`

```text
oats teams [--dir <d>] [--max-age <s>] --json
oats teams add <label> --team <id> [--description <d>] [--no-default] --json
oats teams remove <label> --json
oats teams default <label> [--if-absent | --expect <label>] --json
```

```json
{"teamsApi":2,"deployment":"/w","localTeams":true,"defaultTeam":{"label":"mine","team":"mine:ana.aweb.ai","from":"deployment"},
 "teams":[{"label":"mine","team":"mine:ana.aweb.ai","description":null,"from":"local","default":true,"at":"oats-local.yaml#/teams/mine"},
          {"label":"docs","team":null,"description":null,"from":"shared","default":false,"at":"github.com/acme/agents:oats-workspace.yaml#/teams/docs"}],
 "souls":{"*":{"teams":["docs"]},"security-souls/*":{"default":"security","teams":["engineering"]}},
 "problems":[{"code":"team-unmapped","label":"docs","default":false,"severity":"warning","at":"github.com/acme/agents:oats-workspace.yaml#/teams/docs",
              "message":"shared team docs has no provider id yet","fix":"its owner runs `oats aweb setup`, then commits the id"}]}
```

- `localTeams`: the workspace's answer (`true`/`false`), `null` in the
  standalone view. `defaultTeam` is the `DefaultTeam` a soul without a
  `souls:` default gets here (`from` `"deployment"` or `"workspace"`), or
  `null`.
- `teams[]`: every declared team by label, `{label, team, description, from,
  default, at}`; `default` marks that `defaultTeam`; `at` is a pointer into
  `oats-local.yaml` or `<workspace key>:oats-workspace.yaml#/teams/<label>`.
  A collision shows the shared definition.
- `souls`: the workspace's `souls:` as committed (`{}` when none).
  `problems`: the deployment's [team readiness items](#team-readiness-items).
  The command discovers the workspace (every member's souls), for the
  `team-soul-unknown` check.
- The verbs never call a provider. They validate, rewrite `oats-local.yaml` in
  place, and answer the document plus `changed: bool`.
- **Where local teams are not allowed**, `add` and `default` are refused
  before anything is written: `E_WORKSPACE_SCHEMA {reason:
  "local-teams-closed", path, keys}` (`keys` what the verb writes). `remove`
  still runs there: taking local teams away is the last step of committing
  them in the workspace.
- **`add`**: the first team added also becomes the local `defaultTeam`. A
  label already declared is `E_TEAM_EXISTS {label, from, observed: {label,
  team, from}}` (`observed` is the declared mapping; `from` is `"local"` or
  `"shared"`); a bad label or no `--team` is `E_BAD_ARGS`.
- **`add --no-default`** (feature `teams-conditional-default`) writes the
  mapping and never touches `defaultTeam`. A mapping already declared with
  the same label and the same team id (local or shared) is reuse: the answer
  is `changed: false, reused: true`, so a setup can retry it. The description
  is neither compared nor changed. The same label with another id is
  `E_TEAM_EXISTS` as above. `reused` appears only on that answer. Where local
  teams are not allowed, `add --no-default` is refused with local-teams-closed
  like every `add`, before reuse is considered.
- **`remove`**: a label the local `defaultTeam` names is `E_TEAM_IN_USE
  {label, usedBy: ["defaultTeam"]}`; a shared label is `E_TEAM_SHARED {label,
  at}` (a label in both files can be removed locally); unknown is
  `E_TEAM_UNKNOWN {label}`.
- **`default`**: any declared label, else `E_TEAM_UNKNOWN`.
- **`default --if-absent`** sets it only where the deployment has no effective
  default (this document's `defaultTeam` is `null`); **`default --expect
  <label0>`** only where the effective default's label is `<label0>`, local
  or inherited from the workspace (feature `teams-conditional-default`). The
  two together are `E_BAD_ARGS`. A failed condition is `E_TEAM_DEFAULT_MISMATCH
  {expected: {absent: true} | {label}, observed}`, `observed` being the
  `defaultTeam` exactly as this document reports it (or `null`); nothing was
  written. A soul's `souls:` default is not the deployment's and is not
  looked at. The refusals above run first, in order: `E_BAD_ARGS`,
  local-teams-closed, `E_TEAM_UNKNOWN`, then the condition. When the
  condition holds and `<label>` already is the local default, `changed` is
  `false`.
- **Flags**: each form refuses a flag it does not take with `E_USAGE {flag}`,
  naming the flag and the usage, before anything is read. `add` takes
  `--team`, `--description`, `--no-default`; `remove` none; `default`
  `--if-absent`, `--expect`; every form `--dir` and `--json`, and the read
  form `--max-age` (on a write form, `--max-age` is the kernel's own
  `E_BAD_ARGS`, as for every write verb). `--help` is the kernel's usage
  answer, as for every command.
- **Rendering** (0.53.0). The file is written without folding lines: a value
  past 80 columns stays on its line. Before, a write re-wrapped such a line
  (the same value, over two lines). A file written as JSON (it opens with
  `{`, and the kernel reads it as strict JSON) is written back as JSON: it
  keeps the order of its keys and its final newline, or the absence of one,
  and its indentation becomes two spaces. Before, a write to such a file
  failed with no answer. A rewrite the kernel could not read back is
  `E_WORKSPACE_SCHEMA`, and nothing is written.
- A write that would introduce an unknown reference is refused with that
  code; an invalid result is `E_WORKSPACE_SCHEMA`.
- **Writes** edit `oats-local.yaml` in place and touch only the entries that
  change: comments and styles elsewhere, including inline comments on sibling
  entries, are kept. The file is replaced whole, by a rename, and the new
  file keeps the permission bits of the old one. An `oats-local.yaml` that
  is a symbolic link is replaced by a regular file with its target's bits,
  and the target is not written. Each verb re-reads the file and judges its
  refusals on it as it is now, and writes only if the file did not change
  meanwhile (else it redoes the edit on the new content). A file that keeps
  changing is
  `E_LOCAL_CHANGED {path}`; nothing was written. The condition of `--if-absent`
  and `--expect` is judged the same way, on the file as it is now and again on
  every redo.
- **Concurrency.** Every `add`, `remove` and `default` holds
  `<deployment>/.agents/locks/local.lock` for its whole read-compare-write.
  Every other kernel command that rewrites `oats-local.yaml` holds the same
  lock and answers the same two codes: [`oats soul launch
  set|remove`](#oats-soul-launch), [`oats launch-config
  set|remove`](#launch-configurations) and [`oats schedule|trigger
  enable|disable`](#schedules-and-triggers) of a workspace item.
  Among concurrent `oats teams` writers on one deployment, a conditional write
  therefore never overwrites a default another of them set: when two race, the
  later one sees the earlier result and refuses with
  `E_TEAM_DEFAULT_MISMATCH`. The lock is a file that names the process
  holding it: one left by a command that was killed is taken over by the next
  command. A lock whose holder is still running after 5 s is `E_LOCAL_BUSY
  {path, lock}`, and so is one that cannot be judged: a record that is
  unreadable, a holder that cannot be told to be running or gone, or a lock
  directory written by an earlier kernel. The message says which was found and
  names the path to remove when no oats process is editing; nothing was
  written. The limits: a person or tool editing
  `oats-local.yaml` directly does not take the lock (the content compare still
  catches most such edits, but not one landing between the compare and the
  rename), and changes to the committed `oats-workspace.yaml` (a pull, a
  merge) are not serialized with it: the condition reads the workspace file
  when it is judged, and that is the only promise.

<a id="oats-soul-teams"></a>
### `oats soul teams`

```text
oats soul teams <soul>|'*' [--dir <d>] [--max-age <s>] --json
```

```json
{"soulTeamsApi":2,"soul":"incident-responder","key":"security-souls/incident-responder",
 "match":"security-souls/incident-responder","defaultMatch":"security-souls/*",
 "defaultTeam":{"label":"security","team":"security:acme.aweb.ai","from":"soul"},
 "teams":[{"label":"security","team":"security:acme.aweb.ai","default":true,"from":"shared","via":["default"]},
          {"label":"docs","team":null,"default":false,"from":"shared","via":["workspace"]},
          {"label":"engineering","team":"engineering:acme.aweb.ai","default":false,"from":"shared","via":["workspace"]}]}
```

- Read only. `key` is the soul's key; `match` the `souls:` key its teams come
  from and `defaultMatch` the one its default comes from (`null`: none
  matches, or none sets a default). For `'*'`, `soul`, `key` and the only
  pattern tried are `"*"`. Soul lookup: `E_SOUL_UNKNOWN`, `E_SOUL_AMBIGUOUS`;
  the soul's teams: `E_WORKSPACE_SCHEMA` (local-teams-closed), `E_TEAM_UNKNOWN`.
- The edit flags `--add`, `--remove`, `--default` and `--clear-default` were
  removed in 0.38.0: `E_BAD_ARGS` with details `{flag, replacement: "souls: in
  oats-workspace.yaml (a PR to the workspace file)"}`, before anything else
  is judged.

<a id="oats-soul-launch"></a>
### `oats soul launch`

Feature `soul-launch` (OATS 0.53.0). The supported writer of
`oats-local.yaml` `souls.launch`, a soul's
[launch preference](#launch-preferences) on this machine.

```text
oats soul launch set <soul>|'*' (--launch-config <name>|none | --harness pi|claude|codex [--model <id>]) [--plan] [--dir <d>] --json
oats soul launch remove <soul>|'*'|<exact key> [--plan] [--dir <d>] --json
```

```json
{"soulLaunchApi":1,"action":"set","plan":false,
 "key":"example.pkg/reviewer","souls":["example.pkg/reviewer"],
 "level":"/abs/deployment","file":"/abs/deployment/oats-local.yaml",
 "before":null,"after":"private","changed":true,
 "launch":{"declared":null,"effective":{"harness":"claude","model":null,"launchConfig":"private"},
           "from":"local","at":"oats-local.yaml#/souls/launch/example.pkg~1reviewer","problem":null},
 "unmatched":[],"unread":null}
```

One closed answer for `set`, `remove` and their plans.

- **`set`** names the soul as a spawn does (`E_SOUL_UNKNOWN`,
  `E_SOUL_AMBIGUOUS`) and writes the key that soul has: its bare name, or
  `<package>/<soul>`. `'*'` is the machine default. Exactly one of
  `--launch-config` and `--harness`; `--model` only with `--harness`
  (`E_BAD_ARGS`). Each of them is given once and with a value, and the
  command takes one name: a flag repeated, a flag with no value at any
  occurrence, and a second name are `E_BAD_ARGS`, on `remove` too.
  `--launch-config <name>` writes the name (`none` too) and
  `--harness` the inline `{harness, model?}`. A harness that is not installed
  is not refused: `launch.problem` says what a spawn would refuse.
- **`remove`** tries its argument **first as the exact text of a key in
  `souls.launch`**, with no read of the workspace; otherwise it names a soul,
  as for `set`, and removes that soul's key. Removing the last entry removes
  `souls.launch`, and `souls` when that leaves it empty.
- **`--plan`** runs every check and writes nothing. Its answer is the
  apply's with `plan: true`, and a state that refuses the apply refuses the
  plan with the same code. It takes no lock, so it never answers
  `E_LOCAL_BUSY`.
- **The read.** Both forms read the workspace live: `--max-age` is refused
  (`E_BAD_ARGS`) with and without `--plan`, as for every write verb, and the
  answer never carries `observation`.

| Field | Meaning |
|---|---|
| `action` | `"set"` or `"remove"` |
| `plan` | `true`: nothing was written |
| `key` | the `souls.launch` key written or removed, exactly as in the file; `"*"` for the machine default |
| `souls` | the qualified names of the offered souls that key applies to, sorted. More than one when two members offer a soul of that name: the entry pins all of them. `[]` for a key that is the key of no soul; `null` for `"*"` |
| `level`, `file` | the deployment and its `oats-local.yaml` |
| `before`, `after` | the entry: `null` (none), a string (a launch configuration's name, or `none`), or `{harness, model}` with `model` `null` when it has none |
| `changed` | `false` when the file already said it: nothing was written |
| `launch` | the [`Launch`](#the-launch-report-launch) report a spawn with no flags would decide for the named soul, with the file as it is after this change (as it would be, under `--plan`). After a `remove` it shows what the soul falls through to. For a key given by its exact text, the soul is the first of `souls`. `null` for `"*"` and for a key that is the key of no soul |
| `unmatched` | the keys of `souls.launch` that are the key of no offered soul after this change, sorted by key: `[{key, at, value, suggestions}]`. `at` is `oats-local.yaml#/souls/launch/<key>` (JSON-pointer escaped), `value` the entry as in `before`, `suggestions` at most three offered soul keys: those with the key's bare name (the part after the last `/`) first, then those within two edits of it. `"*"` is never listed, and neither is a key the read could not check (a member unconfirmed, a soul skipped with a problem, a package declared and not locked). `[]`: no key is known to name no soul |
| `unread` | `null`, or `{code, message}` when a `remove` by exact text ran although the workspace's souls could not be read |

- **Read `unread` first.** When it is not `null`, the answer says nothing
  about souls: `souls`, `launch` and `unmatched` are `null` for that reason
  and no other. In every other answer `unmatched` is a list, and `souls` and
  `launch` are `null` only as the table says.
- **The write** is the one `oats teams` makes (above): one entry set or
  deleted in the parsed document, under
  `<deployment>/.agents/locks/local.lock`, from the file as it is now, redone
  when the file changed under it. The file is rewritten, and every other
  entry keeps its value and its comments. Before the rename the rewritten
  text is validated against the local schema and read back: it must equal
  the old value everywhere but the one entry.
- **Refusals**, all before a byte of the file changes: `E_USAGE` (no `set` or
  `remove`; a flag the form does not take, `--home` and `--soul` among them,
  with `details: {flag}`), `E_BAD_ARGS`, `E_LOCAL_MISSING`, `E_SOUL_UNKNOWN`,
  `E_SOUL_AMBIGUOUS`, `E_LAUNCH_CONFIG_UNKNOWN {name, from, at}` (a
  `--launch-config` name this file does not declare: the fact a spawn would
  report, said before the file holds it), `E_LAUNCH_PREFERENCE_UNKNOWN {key,
  keys}` (a `remove` of an entry the file does not have; `keys` are the
  entries it has), `E_LOCAL_BUSY {path, lock}`, `E_LOCAL_CHANGED {path}`,
  `E_WORKSPACE_SCHEMA` (the rewritten file would be invalid, or the kernel
  would not decode it, `details: {problems}`; or it would not read back as
  this one edit, `details: {path,
  reason: "read-back", differs}` with `differs` the JSON pointers that
  differ, never their values), and whatever the read of the workspace
  answers when `set`, or a `remove` that names a soul, cannot read the souls.
- Text mode says the same in lines: what was set or removed and in which
  file; the souls the entry applies to, when more than one; what the next
  spawn of that soul selects; and each key that still names no soul, with
  the command that removes it.

### The messaging provider's teams document

The messaging provider's `teams` operation (`messaging:teams`) is produced by
the provider (oats.aweb 1.17 or later), not the kernel:

```json
{"defaultTeam":{"label":"antares","team":"antares:ana.aweb.ai","from":"deployment"},
 "eligible":[{"label":"oats","team":"oats:oats.aweb.ai","joined":true}],
 "joined":[{"label":"oats","team":"oats:oats.aweb.ai","identityHome":"/w/agents/oe/instances/oe-1/.aw-teams/oats","receive":"live","since":"2026-09-28T09:00:00.000Z"}],
 "left":[{"label":"reviewers","team":"reviewers:acme.aweb.ai","at":"2026-09-28T09:30:00.000Z","reason":"no-longer-eligible"}],
 "at":"2026-09-28T10:00:00.000Z"}
```

`defaultTeam` is the kernel's `DefaultTeam` from the environment. `eligible`
are the non-default `OATS_TEAMS` rows; `joined[].receive` is `live` or
`poll`; `left` holds the last 20 leaves. A join or leave answer adds
`actions: [{action: "join" | "leave", label, released?, receipt?}]`. There is
no `primary` and no `unmapped`: unmapped teams are kernel readiness items.

<a id="team-readiness-items"></a>
### Team readiness items

`oats teams` lists them under `problems[]` as `{code, severity: "failure" |
"warning", message, fix, …}`. `oats readiness` lists the soul's under
`checks.configured` with `subject` `"team <label>"` (or `"teams"`), `producer:
"team model"`, `code`, `reason` (the message), `remedy` (the fix), `status:
"fail"`, `required: true` for a failure and `false` for a warning, plus the
problem's own keys.

| Code | Severity | Keys | When |
|---|---|---|---|
| `E_TEAM_UNCONFIGURED` | failure | | messaging is active and the soul has no default |
| `team-unmapped` | failure if `default`, else warning | `label`, `default`, `at` | a shared team without `team` |
| `team-label-collision` | warning | `label`, `shared`, `local` (each `{team, description, at}`) | a label in both files |
| `default-team-changed` | warning | `recorded`, `current` | `--home` with live teams: the default changed since the spawn |
| `E_TEAM_UNKNOWN` | failure | `label`, `at` | a local default no file declares |
| `E_WORKSPACE_SCHEMA` | failure | `condition: "local-teams-closed"`, `path`, `keys` | `oats-local.yaml` declares `teams` / `defaultTeam` and the workspace does not allow local teams |
| `team-soul-unknown` | warning | `key`, `at` | a `souls:` key that is no discovered soul's key, or a `<name>/*` pattern that matches none of them; never `"*"` (a typo guard; a pattern's `message` and `fix` are its own) |

`E_TEAM_UNKNOWN` and local-teams-closed are also spawn, preview and inspect
refusals (local-teams-closed as `E_WORKSPACE_SCHEMA` with details `{reason,
path, keys}`). While local teams are closed, that one item is the soul's only
team item. `team-soul-unknown` is reported where the souls are discovered
(`oats teams`, readiness).

```json
{"code":"E_WORKSPACE_SCHEMA","severity":"failure","condition":"local-teams-closed","path":"oats-local.yaml","keys":["teams","defaultTeam"],
 "message":"oats-local.yaml declares teams, defaultTeam, but oats-workspace.yaml does not allow local teams (localTeams: true): either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml",
 "fix":"either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml"}
```

`oats doctor --json` lists local-teams-closed under `problems[]` (text: `!
E_WORKSPACE_SCHEMA (local-teams-closed): …`). Doctor stays offline: it reads
only the workspace file this machine's parsed cache holds; when there is
none, it adds no problem and says so in `information[]`:
`"local-teams-closed: whether oats-workspace.yaml allows oats-local.yaml
teams/defaultTeam (localTeams: true) couldn't be checked: this deployment
hasn't observed its workspace yet; run oats sync"`. A removed key in
`oats-local.yaml` makes doctor answer that refusal, as for any unreadable
local file.

<a id="operator-coverage-items"></a>
### Operator coverage items

(0.44.0, [#671](https://github.com/awebai/oats/issues/671)) Every workspace
needs an operator: a soul that composes `oats.setup`. A soul the workspace
offers **covers** it when all of these hold on this machine:

- it is a confirmed member's soul, a locked package soul or an external soul;
- it is not in `souls.disabled`;
- it resolves as a spawn would;
- its modules include `oats.setup`;
- it does not empty the messaging slot the workspace fills (`messaging:
  none`), so it stays reachable. Emptying `knowledge` or `tasks` does not
  disqualify it (0.45.0).

It covers a team when that team is among its resolved teams. Detection is by
composition only: a soul's name never counts, and there is no role marker. An
eligible soul is not a launched or authorized seat. These are warnings: they
never refuse anything, and nothing is spawned.

`oats readiness` lists them under `checks.configured` with `producer:
"operator coverage"`, `required: false`, `code`, `reason` and `remedy`. Team
items cover the subject's own teams only.

| Code | Subject | Status | Keys | When |
|---|---|---|---|---|
| `operator-soul-missing` | `operator` | `fail` | `evidence.excluded` | no soul the workspace offers composes `oats.setup` |
| `operator-team-uncovered` | `team <label>` | `fail` | `label` | no such soul is eligible for one of the subject's teams |
| `operator-coverage-unknown` | `operator` | `unknown` | | a question is still open and a source could not be read; it never asserts absence |

A source could not be read when:

- the workspace itself could not be read;
- only its member view could (an unreadable host);
- discovery dropped a member as `cannot-read`;
- a soul file or listing could not be read;
- a resolution hit `E_REMOTE_UNREADABLE`.

A covering soul that was found is still reported. Any other refusal belongs to
the soul, since a spawn would meet it too, so that soul does not cover.

`evidence.excluded` lists the souls that cannot cover although they are
relevant, each as `{soul, code}`:

- a soul whose `soul.yaml` names `oats.setup` but that is disabled
  (`E_SOUL_DISABLED`), ambiguous (`E_SOUL_AMBIGUOUS`) or refused (the
  resolution's code);
- a soul that composes `oats.setup` but empties the messaging slot the
  workspace fills (`slot-none`, with `slots: ["messaging"]`).

Coverage that holds adds no item.

`oats doctor` stays offline. It resolves the souls from this machine's cache
only (no git process, no network) and checks the workspace and **every**
declared team. It lists `operator-soul-missing` and `operator-team-uncovered`
under `problems[]` as `{code, label?, message, remedy}` (text: `! <code>:
<message>`, then the remedy).

Doctor reads the resolutions that `oats souls`, readiness and spawn keep in the
cache. `oats sync` alone does not resolve souls. When the cache cannot answer,
doctor adds no problem. Instead it adds one `information[]` line, starting
`operator-coverage-unknown:`, whose remedy is `oats sync`, then `oats souls`.
The cache cannot answer when:

- the machine never synced;
- the cache was pruned;
- a soul was not yet resolved here;
- the deployment uses a configured `standalone:` view, whose membership read
  is not cached. There, ask readiness.

Any other error, such as an invalid lock, is named as itself.

<a id="soul-launch-preferences-feature-launch-preference-oats-0300"></a>
## Launch preferences

Feature `launch-preference` (OATS 0.30.0): gate every field and flag below on
it. Design: [soul launch preferences](design/2026-09-28-soul-launch-preference.md).
Every object shape here is closed.

- **The soul** may declare `launch: {harness, model?}` in soul.yaml.
  - `harness` is `pi`, `claude` or `codex`. `model` is a non-empty model id for
    that harness.
  - Nothing else is allowed (no args, env, yolo or executable; those stay host
    facts, in launch configurations). Another key is `E_WORKSPACE_SCHEMA`.
  - A package soul may declare one too.
- **The machine** may override it in `oats-local.yaml` `souls.launch`. A key is
  a soul key (as for `souls.teams`: `"*"`, a bare soul name, or
  `<package>/<soul>`). A value is a `launch-configs` name in the same file, or
  an inline `{harness, model?}` with the soul's rules. From OATS 0.53.0 the
  key is written by [`oats soul launch set|remove`](#oats-soul-launch)
  (feature `soul-launch`).
  ```yaml
  souls:
    launch:
      "*": opus                                          # every soul on this machine
      oats-engineering-expert: opus                      # a launch configuration
      oats.engineering/code-reviewer: {harness: codex}   # an inline preference
  ```
- **Migration.** 0.29.x refuses an unknown soul.yaml key, and members are read
  at their latest commit. A committed soul gains `launch:` only on the flag day
  (every deployment of the workspace runs 0.30). Until then, use `souls.launch`
  or `--launch-config`.

**Precedence** for a new selection. The first layer with a value decides:
1. The flags: `--launch-config` or `--harness` (`from: "flag"`). `--model`
   alone keeps the next deciding layer's harness and replaces only its model.
2. `souls.launch.<key>` (`"local"`).
3. `souls.launch."*"` (`"local-default"`).
4. The soul's `launch` (`"soul"`).
5. The host default: `pi`, its own model, no configuration (`"host"`).

- A **launch configuration** name runs that configuration's full recipe.
- An **inline or soul preference** runs its harness with this host's baseline
  for it (the executable the host resolves; no args, no env) and its `model`.
- A preference is a unit. Without `model`, the harness's own model runs; a
  lower layer's model is never borrowed. A model never crosses harnesses
  (`E_MODEL_UNKNOWN`, as before).

**Existing homes.** A home's recorded launch is frozen. A plain `session
start`/`restart` runs it unchanged. The precedence decides only a new
selection: a spawn, a start/restart with `--launch-config` or `--harness`, or
a start/restart with `--reselect-launch`, which applies the current layers
without naming anything. A start/restart with `--model` alone is not a new
selection: it keeps the recorded harness (and configuration) and replaces only
the model (`modelFrom: "start"`; `launchFrom` is unchanged). **A changed preference does not affect
a running or existing home until `--reselect-launch` or a respawn.** Readiness
shows the drift as `launch-changed`.

**Refusals** (spawn, preview, and a reselecting start):
- `E_LAUNCH_PREFERENCE_UNMATCHED {soul, from, at, keys, fix}` (0.53): the
  launch names none (no `--launch-config`, no `--harness`; `--model` alone
  names none), its soul has no `souls.launch` entry of its own, and
  `souls.launch` holds a key that is the key of no soul the workspace offers.
  The kernel cannot tell which soul that key was meant to pin, so the launch
  the fall-through would decide is refused. It is checked before the three
  refusals below, which describe that fall-through launch. Refused: `oats
  spawn`, preview and apply, with the same code and `details`, and `session
  start|restart --reselect-launch`, before anything is created, stopped or
  started. A soul with its own entry, a launch named by a flag, and a plain
  start or restart go on.
  - `soul`: the soul key of the launch refused. `from`, `at`: the layer that
    would have decided it (`"local-default"`, `"soul"` or `"host"`; `at` as
    in the `Launch` report, `null` for the host).
  - `keys`: every such key, sorted by key, `[{key, at, value,
    suggestions}]`, the rows of `unmatched` in
    [`oats soul launch`](#oats-soul-launch). A client builds the two
    commands from `key` and `value`; it does not parse the sentence.
  - `fix`: "pin the soul each key was meant for (oats soul launch set), then
    remove the key (oats soul launch remove <key>); or name this launch with
    --launch-config <name> or --harness <h>". The order is `set`, then
    `remove`: removing first ends the refusal and leaves the soul on the
    fall-through.
  - The message names at most three keys, then "and K more", and it and
    `fix` are at most 1024 characters each, with no line break, whatever the
    file holds. `keys` is complete.
  - No text of a launch answer holds a character the kernel never prints (a
    control character, a line or paragraph separator, a bidi control, an
    invisible hider, a tag character): a refusal's `message` and `fix`, a
    report's `problem`, a problems row. The schema of `oats-local.yaml`
    admits no key with one, so the file brings none. Were one handed to an
    answer all the same, the sentence names it with each such character
    replaced by U+FFFD and gives no command for it: it says the key is
    deleted from `souls.launch` in the file by hand. `keys[].key` is always
    the exact key.
  - **Unmatched, or not checked.** A key other than `"*"` matches when an
    offered soul has that soul key (a soul in `souls.disabled` included).
    A key that matches nothing is *not checked*, and refuses nothing, when
    the source that could hold its soul was not read: a bare key while a
    member is not confirmed or a member's or an external soul was skipped
    with a problem; `<package>/…` while that package is declared and not
    locked, or one of its souls was skipped; every key in the standalone
    view of a workspace whose host cannot be read. What a read did not
    record, it did not establish: a read that carries no record of what it
    skipped leaves every key not checked, and a member whose listing carries
    none counts as one with a soul skipped. Every other key that
    matches nothing is unmatched, `<member>/<soul>` among them (a member's
    soul is keyed by its bare name). When the workspace cannot be read at
    all, the answer is that read's own error. `"*"` is never reported.
  - **Where else it is said.** `oats souls` and `inspect --soul`: `launch.problem`
    on each soul a spawn would refuse, and `oats souls` `problems` gains one
    row per key (below). `oats doctor`, offline, from this machine's cache:
    `problems[]` gains `{code, key, at, value, suggestions, message,
    remedy}` per key (text: `! <code>: <message>`, then the remedy), whose
    message says that it speaks about this machine's last read of the souls
    and that a spawn reads the workspace itself and is the authority. For a
    key that read could not check, and when the cache cannot answer, doctor
    adds an `information[]` line that starts `launch-preference-unchecked:`.
    The line is information: it changes no exit status and refuses nothing.
    `inspect --home` `launchCurrent` and readiness `launch-changed` make no
    read of the workspace and do not carry this problem; the
    `--reselect-launch` they point to refuses.
- `E_HARNESS_UNAVAILABLE {harness, from, at, fix}`: the chosen harness has no
  executable on this machine. There is no fallback to another harness. `fix`
  names the command that pins the soul (0.53), by the layer that chose the
  harness:
  - the soul's own `launch:` or the host default: "install <harness>, or pin
    this soul on this machine (oats soul launch set <soul> --launch-config
    <name> | --harness <h>)";
  - the soul's own entry of `souls.launch`: "install <harness>, or pin this
    soul to another launch (oats soul launch set <soul> --launch-config <name>
    | --harness <h>)";
  - `souls.launch."*"`: "install <harness>, name another launch for every soul
    without an entry (oats soul launch set '*' --launch-config <name> |
    --harness <h>), or pin this soul to its own (oats soul launch set <soul>
    --launch-config <name> | --harness <h>)";
  - a flag: "install <harness>, or choose another --harness / --launch-config".

  The message says why, names the layer's location (`at`) and ends with the
  `fix`. It stays within 1024 characters: a location too long for that gives
  way to the layer in words ("the soul's own launch", for example), and
  `details.at` keeps it.
- `E_LAUNCH_CONFIG_UNKNOWN {name, from, at}`: `souls.launch` names a launch
  configuration this `oats-local.yaml` does not declare. As a `Launch`
  report's `problem`, its `fix` is "declare launch configuration <name> (oats
  launch-config set), or pin the soul to another (oats soul launch set <soul>
  --launch-config <name>)"; where `souls.launch."*"` named it, "declare launch
  configuration <name> (oats launch-config set), name another for every soul
  without an entry (oats soul launch set '*' --launch-config <name>), or pin
  the soul to one (oats soul launch set <soul> --launch-config <name>)".
- `E_LAUNCH_CONFIG_AMBIGUOUS {harness, configurations, fix}` (spawn and its
  preview only, 0.52): the chosen harness has more than one launch
  configuration here (`configurations`, all their names, sorted; the message
  names the first 10, then "and K more", and fewer where it would otherwise
  pass 1024 characters),
  none is
  `default: true`, and the spawn named none. Named means `--launch-config
  <name>`, `--launch-config none`, or a `souls.launch` string; an inline or
  soul preference and `--harness` alone are not. `fix` is "name one with
  --launch-config <name>, pin the soul to one (oats soul launch set <soul>
  --launch-config <name>), or mark one default: true (oats launch-config
  set)"; where `souls.launch."*"` chose the harness it also says, before the
  soul's own pin, "name one for every soul without an entry (oats soul launch
  set '*' --launch-config <name>)". A start or restart of an existing
  home, `--reselect-launch` included, is never refused this way.
- `E_WORKSPACE_SCHEMA`: a malformed `launch` or `souls.launch`, path named.

**A `souls.disabled` entry that names no soul** (oats-project/oats#1772) keeps
no soul off this machine, and spawn does not refuse because of it: a stale
entry fails open, where a stale `souls.launch` key fails closed. `oats doctor`
reports it with the launch check's discipline, offline, from the same read of
this machine's cache:
- An entry matches when spawn's own rule (`E_SOUL_DISABLED`) holds for a soul
  the workspace offers: its bare name, or its qualified name (`<package>/<soul>`
  or `<member>/<soul>`). A disabled soul is still offered. Spawn's rule is
  exact: `<member>/<soul>` for a soul that only another member offers does not
  match.
- `problems[]` gains `{code: "disabled-soul-unmatched", entry, at,
  suggestions, message, remedy}` per entry that matches nothing, in file
  order (text: `! disabled-soul-unmatched: <message>`, then the remedy). `at`
  is `oats-local.yaml#/souls/disabled/<index>`. `suggestions` holds at most
  three qualified names of offered souls, ranked as the launch rows rank
  theirs: the same bare name first, then a bare name within two edits. The
  message says that it speaks about this machine's last read and that a spawn
  reads the workspace itself and is the authority. The remedy is the hand
  edit, replace the entry with the soul it was meant for or remove it: no
  command writes `souls.disabled`.
- An entry is *not checked*, and gets an `information[]` line that starts
  `disabled-soul-unchecked:` instead of a row, when the source that could
  hold its soul was not read, for the reasons of the launch check: an entry
  under a package that is declared and not locked, or one of whose souls was
  skipped; any entry not under the package of an offered package soul while
  a member is not confirmed or a member's or an external soul was skipped (a
  bare name, `<member>/<soul>`, or a prefix that may be a member's name);
  every entry in the standalone view of a workspace whose host cannot be
  read, or a read that kept no record of what it skipped. When the cache
  cannot answer at all, one such line names the entries.
- Doctor still exits 0. With no `souls.disabled`, or an empty list, nothing is
  added. Spawn, `oats souls`, readiness and inspect do not change.

### The launch report (`Launch`)

```json
{"declared":{"harness":"claude","model":"claude-opus-5-5"},
 "effective":{"harness":"codex","model":null,"launchConfig":null},
 "from":"local","at":"oats-local.yaml#/souls/launch/oats.engineering~1code-reviewer",
 "problem":null}
```

- `declared`: the soul's own `launch` as `{harness, model}` (`model` may be
  `null`), or `null` when the soul declares none.
- `effective`: `{harness, model, launchConfig}`. `model` is the id passed to the
  harness, or `null` (the harness's own). `launchConfig` is a configuration
  name or `null`.
- `from`: `"flag"`, `"local"`, `"local-default"`, `"soul"` or `"host"`; on a
  home, also `"recorded"` (a home from before 0.30).
- `at`: where the deciding value lives, or `null` (a flag, the host):
  `"oats-local.yaml#/souls/launch/<key>"` (JSON-pointer escaped: `/` is `~1`),
  `"oats-local.yaml#/souls/launch/*"`, `"<repoKey>:<path>/soul.yaml#/launch"`,
  or `"package:<id>:<path>/soul.yaml#/launch"`.
- `problem`: `null`, or `{code, message, fix}` when a spawn would refuse
  (`E_LAUNCH_PREFERENCE_UNMATCHED`, before any other, with `effective` the
  launch the fall-through would have given; `E_HARNESS_UNAVAILABLE`,
  `E_LAUNCH_CONFIG_UNKNOWN`,
  `E_LAUNCH_CONFIG_AMBIGUOUS` with `effective.launchConfig` `null`, or
  `E_LAUNCH_EXECUTABLE` for a configuration whose own executable is missing). Only reports carry it;
  spawn and preview refuse instead. A `fix`, here and in a refusal's
  `details`, is a sentence for a person: its wording may change between
  releases, so a client shows it and never parses it. A report states a
  condition, where a refusal states what was refused: for
  `E_LAUNCH_PREFERENCE_UNMATCHED` the report's `message` names the keys and
  the layer that would decide, and ends "it would be refused."; it does not
  repeat the remedy, which is its `fix` (the refusal's `details.fix`). With `E_LAUNCH_CONFIG_UNKNOWN`,
  `effective` is the host default (`pi`, `null`, `null`): the named
  configuration launches nothing here.
- In listings (`oats souls`, `inspect --soul`, `launchCurrent`) `model` is the
  configured id: no model catalogue is probed. The preview's `model` is the
  resolved one.

### Where the launch appears

- **`oats spawn … --preview --json`**: `launch`, flags applied. The existing
  `harness`, `model`, `launchConfig` equal `launch.effective`, and
  `decision.effective` binds them (a preference edited between preview and
  apply is `E_DECISION_STALE`).
- **`oats inspect --soul <name>`** and **`oats souls` rows**: `launch` as a
  spawn with no flags would decide it here (`from` is never `"flag"`). A soul
  whose harness is missing still lists, with `problem` set. The souls rows'
  Desktop facts `harness`, `model`, `harnessFrom` equal `launch.effective`;
  `harnessFrom` is `"soul"`, `"local"`, `"local-default"` or `"kernel-default"`
  (the host default).
- **`oats inspect --home <abs>`**: `launch` is the record (`from` the recorded
  layer; `declared` the soul's preference then), and `launchCurrent: Launch |
  null` is what `--reselect-launch` would choose now: the home's recorded soul
  copy's `launch` and this deployment's `souls.launch` as they are now (`null`
  when `oats-local.yaml` cannot be read).
- **`instance.json`** (a spawn, and a start that makes a new selection):
  `launchFrom` (a `from` value), `launchAt` (its `at`) and `launchDeclared`
  (the soul's own preference then, `{harness, model}` or `null`). All three
  are absent on a home from before 0.30. A start with `--launch-config` or
  `--harness` records `launchFrom: "flag"`; a plain or `--model`-only start
  keeps them. `harness`, `model`, `launchConfig` and the recipe
  record the effective launch as before.
- **`modelFrom`** (instance.json and roster rows) gains `"local"` and
  `"local-default"` (an inline override's model). `"soul"` is the soul's
  `launch.model`.
- **Readiness** (`--home` only), in `checks.configured`: `launch-changed`, a
  warning (`required: false`), `subject: "launch"`, `producer: "launch
  preference"`, with `recorded` and `current` (each `{harness, model,
  launchConfig}`), `from` and `at` (the current layer's). `remedy`:
  "`oats session restart --reselect-launch`, or respawn". Only a home whose
  recorded launch a layer chose (`launchFrom` `local`, `local-default`,
  `soul` or `host`) is compared: one launched with explicit flags, or from
  before 0.30, never warns.
- **`--reselect-launch`** with `--launch-config` is `E_BAD_ARGS` (choose one);
  with `--harness` the flag decides, as at spawn.

No verb writes `souls.launch`; it is plain YAML. A GUI that edits it checks
the result with `oats inspect --soul <name> --json`.

## Launch prompt results

A launch engages the development-channel confirmation exactly when it starts
Claude with `--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace`
in its argv ([configuration](configuration.md#the-development-channel-confirmation)).
There is no policy field: no preview carries `launchPromptAnswers`. Instead,
`launch-config preview`, the spawn apply's `warnings` and `session start|restart`'s
`warnings` carry one statement, a fixed string beginning `This start passes
--dangerously-load-development-channels`, when the start engages it. `spawn
--preview` does not: the argv comes from the provider's spawn hook, which a
preview does not run. Folder-trust prompts remain unexpected and blocked.

The home's `instance.json` `launchPrompts` always describes the last start
(spawn, start or restart):

- `{status: "not-engaged", startId, at}` for a start that did not engage it, with
  no `launchPromptTarget`;
- `{status: "flag-ignored", reason: "channels-unavailable", signatureId, startId,
  at}` for a start where Claude ignored the flag: a notice block on its screen
  equalled the `flag-ignored` tolerance entry `signatureId`, Claude showed no
  confirmation and no key was sent. No screen text is recorded. The start
  succeeds (`launched: true`) and its `warnings` carry, in place of the statement
  beginning `This start passes`, a fixed string beginning `Claude reported
  that channels are not currently available and ignored the development-channel
  flag`. `launchPromptTarget` is the pane. Claude Code disables channels when telemetry is opted out (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), so a launch
  environment with any of them set gets this status too;
- otherwise the observed result `{status, answers, reason, receipt}`, `status`
  one of `completed`, `blocked`, `incomplete`. After the Enter, no complete
  clean `SETTLE` window within the 30 s bound is `status: "blocked"` with
  `reason: "blocked: observation timeout"` and the submitted Enter in `answers`;
  `incomplete` means an audit, input or evidence failure. A
  `blocked` result also carries
  `differed: {nearest, firstDifference: {index, expected, found}}` (the nearest
  tolerance entry and at most 40 characters of each normalized text at the first
  difference) and, when the blocked screen before any Enter started with Claude's
  running-session banner, `claudeSessionShown: true` (the error and the readiness
  remedy then add that Claude may have ignored the flag with its notice hidden).
  `launchPromptTarget` is the pane.

A `--no-launch` spawn records no `launchPrompts`. Readers must treat
`not-engaged` and `flag-ignored` like an absent value: retire and replay act only
on `blocked` and `incomplete`.

`receipt` carries the actual checked launch-prompt event-write results,
including partial log availability; it is not a receive-readiness receipt.
The `launch-prompt` event records the launch start and pane/PID identity, the
Claude version read from the executable's real path (`claudeVersion`, a semver
or `"unknown"`; `claudeVersionSource`, `"executable-path"` or `"unknown"`; it is
`"unknown"` when Claude is started through a wrapper, whose path carries no
version), the matched entry (`signatureId`) and digest, action and outcome; a miss adds
`differed` (and `claudeSessionShown` as above); a start where Claude ignored the
flag is one row, `status: "flag-ignored"`, `reason: "channels-unavailable"`, with
the `flag-ignored` entry as `signatureId` and no `key`. It carries no `consentSource`. Intent is durable before input;
submission (`submitted`, `failed`, `uncertain`) and an observed screen
transition are distinct. Beyond `differed`'s bounded snippets, raw screen text
is never included in the receipt.

Spawn and start both reuse `E_SPAWN_INCOMPLETE` for retained prompt outcomes,
with `launchPrompts.status` set to `blocked` or `incomplete`. Error details
preserve `instance`, `home`, `launched:"unknown"`, `unconfirmed:true` and add
`retained:true`, `target`,
`parentLineageCommitted`, and `launchPrompts`. Unknown prompts report
`blocked: unexpected prompt`. A start whose answer was submitted but that showed no
complete clean `SETTLE` window (2 s) within the bound reports `blocked` with
reason `blocked: observation timeout`, its `answers` holding the submitted Enter. An incomplete audit can follow a
possible key; clients must not offer automatic key retry. `launched:false` in
retained metadata does not mean there is no process or that another harness
may be allocated. Use runtime inspection and the existing start/restart
lifecycle. Same-key spawn replay cannot convert a blocked outcome to successful
spawn.

`answers` can contain a `submitted` answer even when the final status is
`blocked`: a known question marker after the Enter, or the confirmation coming
back, blocks while the actual pane is active. Consumers must preserve that
submitted receipt and never translate this outcome into “nothing started” or
automatic retry. The [completion rule](launch-prompt-completion.md) closes
observation only; an unknown dialog without a marker can be reported completed.
A private evidence-save failure on completion reports checked `incomplete` with
the same answer and target preserved. Private receipt v2 adds no public DTO fields.

Readiness of a home whose last start recorded `blocked` carries a `launch-prompt`
warning (`required: false`, `producer: "launch prompt"`) naming what differed and
both remedies; it clears when a later start records anything else.

Strict Desktop/pi readers must accept these additive fields before a writer
containing them ships. For operator recovery, see
[launch prompt outcomes](execution-targets.md#launch-prompt-outcomes).

## Spawn

Use `oats spawn --help` (also the spawn section of `oats help`) for the
existing flag inventory, including compatibility and internal inputs. Help
needs no deployment; the preview and apply contracts below govern confirmation
and replay.

### The preview

```text
oats spawn <soul> [the flags of a real spawn] --preview [--max-age <s>] --json
```

Feature `spawn-preview-2`, `spawnPreviewApi: 2`. The preview runs every
preflight a spawn runs and writes nothing, on success or refusal. It reads the
soul from the per-commit cache (`agents/<soul>/souls/<commit12>/`) or fetches
it to a temporary copy (`soulFetched: true`).

```json
{"modules":[
   {"name":"nw-tools","from":{"kind":"member","repoKey":"github.com/nw/agents","commit":"66566512…"},"layer":null,"private":false,"declares":[],
    "changedSince":{"instance":"rm-2","was":"45b86f64…"},"composedFrom":"soul"},
   {"name":"oats.okf","from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"},
    "layer":"knowledge","private":false,"declares":["state-dir"],"changedSince":false,"composedFrom":"workspace"}],
 "teams":[{"label":"eng","team":"eng:nw.aweb.ai","default":true,"from":"shared"}],
 "defaultTeam":{"label":"eng","team":"eng:nw.aweb.ai","from":"soul"},
 "resolution":"abacbdb5a7975098d77007c8","declRevision":"068a0d3f1311a9e84e9aff2e","payloadRevision":"81a368006c610194aa35dbe0",
 "workspace":"github.com/nw/agents","standalone":false,"providers":{},
 "settings":{"nw-tools":{},"oats.okf":{"owns":"rm"}},
 "settingsOrigins":{"nw-tools":{},"oats.okf":{"/owns":{"kind":"soul","at":"soul.yaml#/knowledge"}}},
 "spawnPreviewApi":2,"preview":true,"agent":"rm","kind":"persistent","instance":"rm-api","home":"/w/agents/rm/instances/rm-api",
 "repo":"/w/agents-repo","work":"worktree","subject":{"soul":"rm","agentsRoot":null,"dir":"/w"},
 "decision":{"instance":"rm-api","home":"/w/agents/rm/instances/rm-api","branch":"agents/rm-api","base":{"ref":"github.com/nw/agents","oid":"66566512…"},
             "effective":{"repo":"/w/agents-repo","work":"worktree","harness":"pi","model":null,"launchConfig":null,"yolo":null,"backend":"tmux",
                          "childSpawns":true,"relation":null,"providers":{"nw-tools":{},"oats.okf":{"owns":"rm"}}},
             "resolution":"abacbdb5a7975098d77007c8","revision":"c557d8ec9a272ba1c1739dc3"},
 "preflight":{"status":"complete","budgetMs":20000,"elapsedMs":53},"backendStatus":{"name":"tmux","installed":true,"started":false},
 "harness":"pi","model":null,"modelSource":"native default","launchConfig":null,"backend":"tmux",
 "branch":"agents/rm-api","base":{"ref":"github.com/nw/agents","oid":"66566512…"},"worktree":"/w/agents/rm/instances/rm-api/work",
 "worktreeHooks":[{"capability":"nw-tools","required":true}],
 "relation":null,"parentInstance":null,"policy":{"childSpawns":{"allowed":true,"origin":{"kind":"default","detail":"no spawn option: children allowed"}}},
 "executable":"/usr/local/bin/pi",
 "capabilities":[{"name":"nw-tools","origin":"member:github.com/nw/agents@66566512…"},{"name":"oats.okf","origin":"package:oats.okf@2.1.3"}],
 "skills":["release-checklist",{"name":"okf","source":"module:oats.okf"}],
 "task":null,"soulFetched":true}
```

**Placement.**
- `instance`: `<agent>-<purpose>` with `--purpose`, else `<agent>-<n>`,
  de-duplicated across the deployment; or exactly `--name`
  ([Instance names](#instance-names)). `home` and `worktree` (worktree mode,
  else `null`) are canonical: never derive paths.
- `repo`: `--repo`, else the `clones:` entry, else `<deployment>/<member>`.
- In worktree mode, `branch` defaults to `agents/<instance>` (`--branch <b>`
  overrides); `base` is
  `--base` resolved to `oid`. Without `--base`, when `repo` is a clone of the
  soul's repository, `base` is `{ref: <repo key>, oid: <the commit the spawn
  observed>}`, fetched into the clone at apply (`E_REMOTE_UNREADABLE` when it
  cannot be); otherwise `HEAD`. `E_BRANCH_EXISTS` and `E_BASE_UNKNOWN` refuse
  preview and apply alike.
- `worktreeHooks` (feature `worktree-event`, OATS 0.49.0): for a `worktree`
  spawn, the capabilities whose `worktree` hook the spawn would fire, in the
  order they run, as `[{capability, required}]` (`[]` when none declares
  one); `null` in every other mode. `worktree` stays the path string. The
  text preview prints `worktree hooks: a, b (required)` or `worktree hooks:
  none` ([the worktree event](capabilities.md#the-worktree-event)).
- `subject` echoes `{soul, agentsRoot, dir}` byte-exact.
- `warnings`, present only when there is one, is an array of strings: the
  `launchPromptAnswers` notice when the host file still has that key, and (0.49.0) the message of each
  [capability warning](#capability-warnings-hook-event-unsupported-oats-0490)
  of the resolved modules. The apply's `warnings` carries the same messages.

**Launch.**
- `harness`, `model`, `modelSource`, `launchConfig`, `backend`, `yolo`
  (absent when nothing sets it) are the resolved selection.
  `backendStatus` is `{name, installed, started: false}`, `null` with
  `--no-launch`. `executable` is the resolved harness binary.
- `launchConfigDefault` (0.32, feature `launch-config-default`) is `true`
  when `launchConfig` is this host's default for the harness (its
  executable, args, env and `yolo` apply without being chosen), `false`
  otherwise. Show it, and `yolo`, whenever it is `true`. An explicit
  `--launch-config none` asks for the bare harness and bypasses the default;
  to run the host's default, omit `--launch-config`.
- `launchConfigSource` (0.69) is the directory of the file that declares
  `launchConfig`: the deployment, or `~/.oats/config` for
  [this machine's launch configurations](configuration.md#this-machines-launch-configurations);
  `null` when there is no `launchConfig`. A spawn records the same value.
- `modelSource` is `"explicit"`, `"soul default"`, `"launch-config <name>"`,
  `"native default"` or `"native default (explicit)"` (`--model
  @native-default`). Omitting `--model` and asking for the native default are
  different requests.
- `preflight`: `{status: "complete" | "timeout", budgetMs, elapsedMs}`; all
  native probes share one 20 s budget.
- `policy.childSpawns` is what the instance will record.

**Background** (feature `instance-background`).
- `background` (`true` or `false`) says whether the instance will be listed
  under the clients' Background section
  ([Background instances](#background-instances-oats-instance-background)).
  It is `--background` or `--no-background`, else the soul's
  `background:`, else `false`.
- `backgroundFrom` is `"flag"` or `"soul"`, the layer that declared the
  value; a soul's explicit `background: false` is `"soul"`. It is absent
  when neither declares it.
- Both flags together are `E_BAD_ARGS` (`choose --background or
  --no-background, not both`). The text preview prints `list: background
  (from the soul)` or `(from the --background flag)` for a background
  instance.

**Composition.**
- `modules[]` (feature `instance-modules`): `{name, from, layer, private,
  declares, changedSince, composedFrom}`; `from` is what `instance.json` will
  record. `changedSince` is `null` (no previous instance), `false` (unchanged
  since the newest one) or `{instance, was}`.
- `composedFrom` (feature `preview-composed-from`, OATS 0.30.2): why the
  module is there — `"soul"` (the soul declares it, including a soul entry
  that overrides a workspace default of the same name, a package soul's
  `from: here`, and every module of a standalone view) or `"workspace"` (a
  `defaults.<slot>` or `defaults.capabilities` entry). It is the same value
  `oats inspect --soul` reports as `capabilities[].composedFrom`. It is
  provenance only: it never enters `resolution`, `declRevision`,
  `payloadRevision` or `decision.revision`, and `instance.json` does not
  record it. `from` says where the bytes come from.
- `capabilities[]` (`{name, origin}`, `origin` `package:<id>@<v>` or
  `member:<repoKey>@<commit>`) and `skills[]` (the soul's own skills as
  strings, module skills as `{name, source: "module:<cap>"}`) are display
  only: bind to `modules[]` and `decision`. A module skill's `name` is a
  skill the spawn copies, by the rule it copies by: a manifest entry that
  holds skill directories lists each of them, and a manifest with no
  `skills` lists each `skills/<dir>/` holding a `SKILL.md`, read at the
  module's commit (feature `soul-composed-skills`; earlier kernels named such
  an entry by its own directory, `skills`, and listed nothing for a manifest
  with no `skills`).
- `resolution` (24 hex) hashes `declRevision` (the declarations) and
  `payloadRevision` (the merged payloads). `workspace` is the host key;
  `standalone` marks a standalone view. `task` is the task text or `null`.

**Observation reuse** (feature `spawn-preview-max-age`, OATS 0.33.0).
- `--preview --max-age <s>` reuses member heads this machine observed at
  most `<s>` seconds ago, as the read verbs do ([Observation
  reuse](#observation-reuse-feature-observe-max-age-oats-0311): the same
  values, refusals and fallbacks to a live observation). With the flag (`0`
  included) the result gains `observation: {observedAt, reused,
  localRevision}`, shaped exactly as the read verbs' block; without it the
  preview is exactly as before, and no other field changes shape.
- `decision.revision` covers the heads the preview used, reused or live.
  An apply without `--max-age` (or with `--max-age 0`) observes live: a head
  that moved since the reused observation refuses `E_DECISION_STALE`, and the
  apply records what it observed, so re-preview under `--max-age` to get the
  new head and revision. An apply with `--expect-decision` may reuse heads
  too (feature `spawn-apply-max-age`, [Apply](#apply)).

#### The suggested name (feature `spawn-suggest-name`)

```text
oats spawn <soul> --preview --suggest-name --task-file <f> [the flags of a real spawn] [--json]
```

A preview that also chooses the instance's name, from the task (`--task-file`,
or `--task <text>`). Like every preview it writes nothing and runs no hooks.
- `--suggest-name` with `--name`, `--purpose` or `--expect-decision` is
  `E_BAD_ARGS`. Without `--preview` it names an apply
  ([On an apply](#on-an-apply-feature-spawn-apply-suggest-name)).
- **The call.** The kernel makes one non-interactive call through the
  harness, executable and environment the spawn would launch (the launch
  configuration's `env`, not its `args`), with this prompt on stdin, never in
  argv:

  > Name an agent for this task: 2–4 lowercase words joined by hyphens, describing the work, not the role. Reply with the name only.
  >
  > Task:
  > <the task text, at most 4000 characters>

  It runs from a fresh empty temporary directory, removed afterwards, with no
  `OATS_INSTANCE*` variable, without a shell, in its own process group. It is
  made after the preview's harness checks (the executable's lookup and the
  harness package probes, from where the home will be) and before anything
  that depends on the name (placement, branch, home). It takes what those
  checks leave of the preview's one 20 s preflight budget, which is not
  raised for it: the group is killed after 20 s, or when the budget runs out
  first. Its time counts in `preflight.elapsedMs`; `preflight.status` stays
  that of the checks, so a numbered preview after a `timeout` is confirmed
  like any other. At most 4 KiB of its output is read.
- **It starts none of the user's code: no MCP server, hook, plugin,
  extension or project setting, and no tool on either harness.** Three
  exceptions are stated:
  - Claude Code's own built-in plugins (`cc-plugin-*@builtin`) load as
    they always do, `--bare` included.
  - Hooks in the host's managed policy (`managed-settings.json`) still
    apply: they are the host admin's.
  - pi runs its own credential commands (`!command` keys and headers in
    models.json), as every pi launch does: they are its login.

  A claude login through `apiKeyHelper` is not read (`--setting-sources
  ""`): such a user gets `harness-failed` and a numbered name.

  Each harness's argv is proven to start nothing else
  (`scripts/naming-isolation-proof.mjs`, a recorded run against fixtures,
  rerun by an operator after a harness upgrade). The proof covers claude
  2.1.288 and pi 1.3.0, on Linux; macOS is not proven.
  - **claude**, model `haiku`: `-p --tools "" --strict-mcp-config
    --setting-sources "" --disable-slash-commands --no-session-persistence
    --output-format text --model haiku`. Its native login is kept, which
    `--bare` would not keep.
  - **pi**, the instance's model: `-p --no-session --no-tools
    --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes
    --no-context-files --no-approve [--model <m>]`.
  - **codex** is not supported. Its naming call is not proven to start
    nothing, so a codex soul is numbered with `unsupported-harness`.
- **The name.**
  1. The reply's first non-empty line, as a slug.
  2. Without one or more trailing `-<role>`. The role is the last word of the
     soul's name, after any package qualifier.
  3. At most 4 words, cut at a word boundary to fit
     `64 − 1 − len(role)`.
  4. Nothing left, or only the role, is `invalid-reply`.
  5. The name is `<descriptive>-<role>`. A name that is taken (an instance,
     a soul or a live window, as for `--name`) gets `-2`, `-3`, and so on.
- **The answer** is the full preview, plus `naming`:

  ```json
  "naming": { "source": "suggested", "ms": 2310, "harness": "claude", "model": "haiku" }
  ```

  ```json
  "naming": { "source": "numbered", "reason": "timeout", "message": "claude gave no name within 20 s", "ms": 20000 }
  ```

  - With `source: "suggested"`, `instance`, `home`, `branch` and `decision`
    are those of a preview with `--name <instance>`: an apply with `--name
    <instance> --expect-decision <revision>` matches it.
  - With `source: "numbered"`, they are today's numbered name, and the apply
    goes without `--name`.
  - `reason` is one of a closed set:
    - `no-task`: no task, or a blank one; no call is made.
    - `unsupported-harness`: no call is made.
    - `timeout`.
    - `harness-failed`: a nonzero exit, a signal, or no executable. `message`
      gives the exit or the signal, never the output.
    - `invalid-reply`.
  - `model` is `null` when the harness runs its own default.
  - A failure is never an error: the preview answers.
  - The text preview prints `name: suggested by claude (haiku) in 2310 ms` or
    `name: numbered (<reason>: <message>)`.
- **`--server`:** the call runs on the target machine, through the routed
  preview, and the task travels as a routed spawn's does. A host that does
  not advertise `spawn-suggest-name` is refused (`E_REMOTE_INCOMPATIBLE`)
  before the spawn is sent.

#### On an apply (feature `spawn-apply-suggest-name`)

```text
oats spawn <soul> --suggest-name --task-file <f> [the flags of a real spawn] [--json]
```

An apply with `--suggest-name` and no `--name`, `--purpose` or
`--expect-decision` names the instance on the machine that spawns, by the
preview's call and rules above, through the soul's harness.
- The name is `<descriptive>-<role>`, made unique as a preview's is, and it is
  placed exactly as `--name <name>` would be.
- On any failure the instance is numbered as it is today, and `naming` says
  why. A failed call is never an error: the spawn goes on.
- The call is made before anything is placed, after the executable is
  resolved and the harness packages probed. An apply has no preflight
  budget: the call has its own 20 s. Every later bound of the apply (the
  hooks, the launch) starts after it, so the apply can take up to 20 s longer
  than without the flag. A caller with its own deadline on the apply allows
  for that.
- The result carries `naming`, in the preview's shape and with its closed
  `reason` set, whenever `--suggest-name` was given
  ([Apply](#apply), its result). The text answer prints a
  `name: suggested by …` or `name: numbered (…)` line.
- **A race.** Another soul's spawn that takes the name between the naming
  and the placement makes this apply `E_INSTANCE_NAME_TAKEN`, as for `--name`
  (nothing was created by this call; spawn again for another name). The same
  soul's is `E_PLACEMENT_TAKEN`, as for any name.
- Without `--suggest-name`, an apply is unchanged: numbered, with no call.
- **`--server`:** the call runs on the host, through the routed apply. A host
  that does not advertise `spawn-apply-suggest-name` is refused
  (`E_REMOTE_INCOMPATIBLE`) before the spawn is sent; the route never drops
  the flag. A caller that would rather have the host number the instance
  checks the host's `probe.features` and does not send the flag.

**Provider settings.**
- `providers` is the `--provider` map as typed.
- `settings.<cap>`: the merged payload (manifest defaults, then workspace,
  soul, `oats-local.yaml` `settings.<cap>`, `--provider`).
- `settingsOrigins.<cap>` (feature `settings-origins`) maps each leaf pointer
  (`/identity/mode`) to `{kind, at}`: `kind` is `manifest-default | workspace |
  soul | host | spawn`, `at` names the place.
- `--provider <cap> <key>=<value>` (feature `spawn-provider-payload`,
  repeatable, `a.b=c` nests): a malformed pair is `E_BAD_ARGS`; a capability
  the soul does not resolve is `E_CAPABILITY_MISSING {capability, soul,
  modules}`.
- Any other positional after the soul, or a flag spawn does not read, is
  `E_BAD_ARGS` naming the argument, before anything is resolved; a bare
  `key=value` is refused with the `--provider <capability> key=value` form.

### The decision

`decision` is `{instance, home, branch, base, effective, resolution,
revision}`. `effective` (feature `spawn-apply-2`) is `{repo, work, harness,
model, launchConfig, yolo, backend, childSpawns, relation, providers}`;
`relation` is `null` or `{kind, anchor: {instance, agentsRoot}}`; `providers`
(feature `served-identity`) equals `settings`. `effective.background: true`
(feature `instance-background`) is there only when the instance will be
background, so a decision without it keeps the revision it had: an apply
whose resolved value differs from the preview's is `E_DECISION_STALE`.
`revision` (24 hex) hashes the decision.

Apply with `oats spawn <soul> … --expect-decision <revision> --json`. Any drift
refuses `E_DECISION_STALE` with the fresh `details.decision`; nothing is
created. Without `--expect-decision` the CLI keeps its interactive
auto-suffix.

### Apply

Feature `spawn-apply-2`, `spawnApplyApi: 1`. The Desktop gates on
`spawn-preview-2`, `spawn-apply-2` and `spawn-idempotency-2`.

- Backend startup runs only after the decision check and the placement
  reservation; a missing backend binary is refused before placement.
- The home is reserved with a non-recursive `mkdir`. A concurrent loser
  refuses `E_PLACEMENT_TAKEN {instance, home}` having touched nothing. Names
  are deployment-wide: a same-name race with another soul ends in
  `E_INSTANCE_NAME_TAKEN` (for `--name` and a suggested name) or
  `E_PLACEMENT_TAKEN`.
- A refused child spawn appends `child-spawn-refused` to the parent's log (on
  apply only).
- `--max-age <s>` with `--expect-decision <revision>` (feature
  `spawn-apply-max-age`, OATS 0.58.0) reuses member heads this machine
  observed at most `<s>` seconds ago, exactly as the preview does (the same
  values and fallbacks to a live observation), so an apply right after its
  preview asks no remote again. The decision is computed from those heads, and
  one that differs from `<revision>` is `E_DECISION_STALE`, as without the
  flag. The answer (success, replay, every refusal) has no `observation`
  block: the preview already gave its "as of".
  Without `--expect-decision` the flag is `E_BAD_ARGS`
  ([Observation reuse](#observation-reuse-feature-observe-max-age-oats-0311)).

**Idempotency** (feature `spawn-idempotency-2`): `--idempotency-key <key>`
with `--expect-decision` records the key and decision in `instance.json`.
- Recovery runs right after naming, before placement or preflight. A retry
  with the same key replays the receipt (`replayed: true`, no second spawn,
  no second wake). The same key with another decision is
  `E_IDEMPOTENCY_CONFLICT {instance, home}`.
- `spawnCompleted` is `false` until launch, lineage and events are done; a
  retry of an unfinished spawn is `E_SPAWN_INCOMPLETE {instance, home,
  launched, unconfirmed: true}` (recover through the session surface).
- The key lives in the home. Mint it on the first confirmation and keep it
  for that intent's retries.
- `wake: {requested, saved, error}` is recorded and replayed; `saved: null`
  means the outcome was not recorded.

**Result** (`oats spawn <soul> … --json`):

```json
{"instance":"rm-api","agent":"rm","home":"/w/agents/rm/instances/rm-api","work":"worktree","branch":"agents/rm-api",
 "base":{"ref":"github.com/nw/agents","oid":"66566512…"},"launched":true,"warnings":[],
 "tmux":{"session":"oats-agents","window":"rm-api","socket":"/tmp/tmux-1000/oats"},"backend":"tmux","repo":"/w/agents-repo","harness":"pi","model":null,"parent":null,"sibling":null,"relation":null,
 "spawnOrigin":"operator","attach":"tmux -S /tmp/tmux-1000/oats attach -t oats-agents","decision":{"instance":"rm-api","revision":"c557d8ec9a272ba1c1739dc3"},"replayed":false,
 "wake":{"requested":false,"saved":null,"error":null},"launchConfig":null,
 "launch":{"version":2,"harness":"pi","launchConfig":null,"launchConfigSource":null,"executable":"/usr/local/bin/pi","executableDeclared":null,
           "executableResolvedFrom":"PATH","args":[],"env":{},"model":null,"hooks":{"launch":{},"env":{},"contributions":[]},"prompt":{"kind":"task-file","file":"TASK.md"}}}
```

(`decision` is abridged: it is the full bound decision.)

- Always present: `instance, agent, home, work, branch, base ({ref, oid}
  the new branch started at; `null` without one), launched, warnings
  (array), tmux ({session, window, socket?} | null), backend ("tmux"), repo, harness,
  model, parent,
  sibling, relation, spawnOrigin (operator | instance), attach, launchConfig,
  launch` (the redacted recipe).
- `launchPrompts` (0.52.0), on a launched spawn: the value its start recorded in
  `instance.json`, in exactly the shape a start's answer carries it (see `oats
  session start`'s result below and [Launch prompt results](#launch-prompt-results)):
  `{status: "not-engaged", startId, at}`, `{status: "flag-ignored", reason:
  "channels-unavailable", signatureId, startId, at}`, or the observed
  `{status: "completed", answers, reason, receipt}`. A `blocked` or
  `incomplete` outcome is `E_SPAWN_INCOMPLETE` instead. A `--no-launch` spawn
  has none. A replay (`replayed: true`) carries the value the home holds when
  it is asked, which is the last start's and not always this spawn's. Its
  `warnings` are the capability contract warnings alone: the warnings of the
  launch itself (that OATS confirms the prompt, or that Claude ignored the
  flag) are not repeated, and `launchPrompts.status` is where a replay says
  it.
- `tmux.socket` is the absolute socket of the tmux server the window was
  created on; a launched spawn has it, a `--no-launch` one does not. It is
  the OATS tmux server's
  ([execution-targets.md](execution-targets.md#the-oats-tmux-server)), where
  earlier kernels recorded the default server's; the shape is unchanged.
- `attach` is one string, a command for a person to paste, the same in text
  and JSON. It is `tmux -S <tmux.socket> attach -t <session>` for a
  launched spawn (earlier kernels: `tmux attach -t <session>`) and `oats session attach
  --home <home>` for `--no-launch`. A value is single-quoted only when it
  holds a character outside `A-Za-z0-9_./:-`. It is not a field to parse:
  read `tmux` for the target.
- `background` and `backgroundFrom` (feature `instance-background`) are the
  preview's. A background spawn writes the home's record with the home's
  other files, so a spawn that rolls back leaves none. A keyed replay answers
  `background` as the home's record reads now, without `backgroundFrom`.
- When they apply: `yolo`, `decision` and
  `replayed` (bound apply), `wake` (keyed apply), `wakeSchedule` and
  `wakeScheduleError` (a requested wake), `worktreeHooks` (feature
  `worktree-event`: only when the spawn ran `worktree` hooks, the receipt
  `[{capability, ok, required, log, exitCode, signal?, timedOut?,
  contract?}]`, `log` being the hook's log file), `naming` (feature
  `spawn-apply-suggest-name`: only with `--suggest-name`, `{source, reason?,
  message?, ms, harness?, model?}` as on the preview).
- A spawn that runs `worktree` hooks can take up to 30 minutes per hook
  ([the worktree event](capabilities.md#the-worktree-event)).

<a id="instance-names"></a>
### Instance names

Feature `spawn-name`. `--name <slug>` is the exact name, with no prefix.
- `--name` with `--purpose`, or without a value: `E_BAD_ARGS`.
- A name that is not a slug (lowercase letters and digits, single dashes),
  equals a soul name, or exceeds 64 characters (derived names included, with
  their suffix) is `E_INSTANCE_NAME_INVALID`.
- A name any soul's `instances/` holds, or a live window of the target
  session on the OATS tmux server carries, is
  `E_INSTANCE_NAME_TAKEN {instance, home, session?}`; a typed name never gets
  a silent `-2`.
- The name is part of the decision.
- Routed (`--server`), `--name` needs a host that advertises `spawn-name`:
  `E_REMOTE_INCOMPATIBLE` otherwise, with nothing sent. A saved route here
  under that name is `E_ROUTE_EXISTS`, before the spawn is sent.
- `--preview --suggest-name` (feature `spawn-suggest-name`) chooses a
  descriptive name for the task, `<descriptive>-<role>`, which the apply then
  passes as `--name` ([The suggested name](#the-suggested-name-feature-spawn-suggest-name)).
  An apply with `--suggest-name` (feature `spawn-apply-suggest-name`) chooses
  it itself ([On an apply](#on-an-apply-feature-spawn-apply-suggest-name)).
- `oats instance suggest-name` (feature `instance-suggest-name`) chooses one on
  this machine for a spawn on another
  ([A name for a spawn elsewhere](#a-name-for-a-spawn-elsewhere-oats-instance-suggest-name)).

### A name for a spawn elsewhere (`oats instance suggest-name`)

Feature `instance-suggest-name`.

```text
oats instance suggest-name --soul <soul> (--task <t> | --task-file <f>) [--harness claude|pi] [--model <m>] [--launch-config <n>] [--dir <d>] --json
```

The name a spawn of `<soul>` would get by `--suggest-name`, chosen on the
machine that asks (a Desktop's, with the spawn dialog open) for a spawn that
may land on another.

- **What it touches.** It resolves no workspace, writes nothing, records
  nothing and reserves no name. It reads only this machine's launch
  configurations (the `oats-local.yaml` in reach of `--dir`, else the working
  directory) and the OATS tmux server's environment, as a spawn's pane would
  have it; it resolves no souls, members, lock or remote. The deployment it
  reads is not added to this computer's deployments list.
- **The soul is only a name.** It gives the role (the last word of the name,
  after any package qualifier) and needn't exist on this machine. It is
  checked as a soul name's shape (`<soul>`, `<package>/<soul>`,
  `<package>--<soul>`), never resolved.
- **Not made unique.** The words, role and length rules are the preview's
  ([The suggested name](#the-suggested-name-feature-spawn-suggest-name)), but no
  `-2` is added: the machine the spawn lands on owns uniqueness, and a name
  taken there is its `E_INSTANCE_NAME_TAKEN` at the apply.
- **The harness and model.** The harness is `--harness`, else the
  configuration's, else claude. Its executable and environment are what a
  spawn on this machine would launch it with: `--launch-config` if given
  (`none` for the bare harness), else this machine's default configuration
  for that harness, else the harness's own executable. The model is
  `--model`, else the configuration's: `@native-default` is the harness's
  own, and a preference list names its first entry (no catalogue is
  probed: the naming call is the only process the command starts). It
  matters for pi; claude always names with `haiku`. The task text goes to this machine's harness and model, as the
  preview's naming does.
- **The call** is the preview's, with the same prompt, argv and isolation,
  and its model call is bounded as the preview's is: at most 20 s and 4 KiB
  of output.
- **The answer** is the usual envelope, `ok: true` whether the name was
  suggested or numbered:

  ```json
  {"schemaVersion": 1, "ok": true, "result": {"name": "fix-flaky-login-developer", "naming": {"source": "suggested", "ms": 2310, "harness": "claude", "model": "haiku"}}}
  ```

  ```json
  {"schemaVersion": 1, "ok": true, "result": {"naming": {"source": "numbered", "reason": "harness-failed", "message": "claude could not be run: claude is not installed on this machine (claude binary not found on PATH)", "ms": 0}}}
  ```

  - `name` is present only when `naming.source` is `"suggested"`.
  - `naming` has the preview's shape, and `naming.reason` its closed set:
    `no-task` (`--task ""`, or a blank task file; no call is made),
    `unsupported-harness` (codex; no call is made), `timeout`,
    `harness-failed` (a nonzero exit, a signal, or no executable here: no
    such executable, or a configuration's `{fromEnv}` reference not set
    here; `message` names the cause, never a value), `invalid-reply`.
  - A naming failure is not an error: `ok: true` with
    `naming.source: "numbered"`.
  - The text answer is the name, or `numbered (<reason>: <message>)`.
- **Refusals** (`E_BAD_ARGS` unless named): no `--soul`, or one that is not
  a soul name's shape; neither or both of `--task` and `--task-file`, or one
  that cannot be read; a `--harness` other than pi, claude or codex; a
  `--harness` that is not the named configuration's; a flag or argument it
  does not take; `--server`. An unknown `--launch-config` is
  `E_LAUNCH_CONFIG_UNKNOWN`.
- **Never routed.** `oats instance` commands route through `--server`, but
  this one runs where it is asked: a name for another machine is decided
  here. `--server` is refused before anything is sent.
- **When the feature is missing** (an older local kernel), a client spawns
  without a name: the host numbers the instance, or names it itself if it
  advertises `spawn-apply-suggest-name` and the client sends `--suggest-name`.

### Spawn origin

For new instances from OATS 0.64.0, `spawnOrigin` describes the caller:
`instance` when `OATS_INSTANCE` and/or `OATS_INSTANCE_HOME` identify an extant
instance home in this deployment, otherwise `operator`. It is recorded in
`instance.json` and reported unchanged by the spawn result and status JSON.

- A home alone must be absolute and resolve canonically to a home here, with a
  readable instance record whose name agrees with its directory.
- A name alone must resolve uniquely to such a home here.
- With both supplied, the name and canonical home must agree. An explicit
  valid home can disambiguate a duplicated historical name.
- Invalid, stale, foreign or contradictory supplied evidence records
  `operator`, with no fallback to another signal. The working directory,
  `OATS_HOME`, `PI_AGENT_*`, relation and attached ownership do not supply
  caller identity. A stopped but extant home counts; no process or tmux
  liveness check is made.

A shell, Desktop or console caller without valid instance context records
`operator`, even with `--parent`. A caller with valid instance context records
`instance`, even without a relation. A shell that inherits that context also
records `instance`. `parentInstance`, `relativeTo` and `relation` still describe
lineage independently; existing child-spawn policy enforcement is unchanged.
This field is informational attribution, not agent-authorship proof, an
identity credential, a security boundary or an authorization input. There is
no flag to choose it.

For a remote spawn (`--server`), attribution uses the host-side caller context.
Caller identity is not forwarded, so the origin is normally `operator`.

Existing homes keep their recorded value, including the relation-based meaning
recorded by earlier kernels; an absent value stays absent in local status.
Idempotent spawn replay returns the recorded value. Remote rows relay the
host's value unchanged, including historical values, and use `null` when the
host does not supply one. Consumers must allow for those historical meanings.

<a id="spawned-by"></a>
### Spawned by

From feature `spawn-attribution`, every new home records `spawnedBy`: the
instance whose session ran the spawn, `{instance, home}` (the canonical
absolute home), or `null`. `instance.json` and the `spawned` event's `data`
carry it as recorded. The `oats status --json` row carries it only in that
shape: an `instance` that is an instance name and an absolute `home`, and no
other key; anything else (a hand-edited record) reads `null`. A home spawned
before the feature has no key on its row. It is apart from lineage: `parentInstance`, `relation`
and `relativeTo` say nothing about it, and a spawn with `--relation unrelated`
from an instance still has a spawner.

It is read by the same check as [Spawn origin](#spawn-origin), plus the
spawner's liveness. The caller is the instance that check confirms; the
kernel then reads its session by its own liveness read (the `running` of
`oats session inspect`, feature `session-inspect-running`, and of status
rows), which has three answers:

- **Running:** the spawner is that instance.
- **Found gone** (a fallback shell, a dead or absent pane, a home that never
  launched, or its tmux server gone): `null`.
- **Cannot tell** (its tmux server cannot be read, its session receipt cannot
  be used): the spawner is kept. As far as anyone knows, that instance runs
  this command. The spawn is never refused.

So `spawnedBy` non-null implies `spawnOrigin: "instance"`, and
`spawnOrigin: "instance"` with `spawnedBy: null` means the spawner's session
was found gone. `spawnOrigin: "operator"` always has `spawnedBy: null`: a
person's shell, the Desktop, an automation (a scheduled job's environment
carries no instance), and a home of another deployment. A `--server` spawn
sends no caller environment to the host, so its spawner is `null` unless the
caller is a live home on that host.

Limits:

- It reads the environment only, so a harness that strips its session's
  environment reads as a person's spawn. That changes the recorded parent,
  never the human.
- The caller is read from an unauthenticated environment, so any process of
  the same OS user can name a live instance as its spawner. That is accepted
  under the custody answer: a convention under the same OS user, not a
  boundary.
- `spawnedBy` and the messaging identity's `attribution`
  ([Attributed human](#attributed-human)) report, and no kernel decision
  reads them.
- `spawnedBy` is written once, at spawn. Retire's lineage repair doesn't
  touch it, and it can name a home that no longer exists.

Spawn hooks get it as `OATS_SPAWNER_HOME` when it is not `null`
([capabilities.md](capabilities.md#commands-and-hooks)).

<a id="spawn-errors"></a>
### Spawn errors

A spawn answers the kernel's own code, as raised, whatever stage raised it
(feature `spawn-kernel-codes`, OATS 0.56.0). Beyond the codes below that is
any code of the kernel a spawn reaches: the deployment's files, where the home
may be, the composition written into the home, reading a package or member at
its commit, the harness's packages, the session, and the work and what a
failed spawn leaves. **A code says nothing about how far the spawn got:**
`details.unconfirmed` does. `E_SPAWN_FAILED` is for an error with no kernel
code; a kernel without `spawn-kernel-codes` answers it for most codes its
kernel stage raised as well.

| Code | Details | When |
|---|---|---|
| `E_USAGE`, `E_BAD_ARGS` | | no soul; bad, contradictory, removed or unknown flags; an argument after the soul; `--same-work` for an instance that would record no parent ([Same work as the parent](#same-work-as-the-parent-oats-instance-same-work)) |
| `E_LOCAL_MISSING`, `E_NO_DEPLOYMENT` | | no `oats-local.yaml`; no `agents/` root |
| `E_SOUL_UNKNOWN` | `{name, members, packages, unconfirmed?}` | no such soul, or not at `--agents-root`. `unconfirmed`, only when a member could not be confirmed: `[{key, reason, detail}]`, which the message repeats with what to do |
| `E_SOUL_AMBIGUOUS` | `{name, repos, qualified}` | several souls answer the bare name; use one of `qualified` |
| `E_SOUL_DISABLED` | `{name, qualifiedName, entry}` | listed in `souls.disabled` |
| `E_UNKNOWN_AGENT` | | the resolved soul is not under the deployment's agents root |
| `E_TEAM_UNKNOWN`, `E_WORKSPACE_SCHEMA` (local-teams-closed) | `{label, at}`, `{reason, path, keys}` | the soul's teams do not resolve |
| `E_NOT_A_MEMBER`, `E_MEMBERSHIP_UNCONFIRMED` | | the soul's repository is not a confirmed member |
| `E_CAPABILITY_MISSING`, `E_CAPABILITY_PRIVATE`, `E_CAPABILITY_INCOMPATIBLE`, `E_COMPATIBILITY` | | a capability cannot be resolved |
| `E_PACKAGE_MISSING`, `E_PACKAGE_INTEGRITY`, `E_LOCK_SCHEMA` | | the lock does not provide it (standalone: `{…, standalone: true, reason: "no-catalog", catalog}`) |
| `E_PACKAGE_INTEGRITY` | `{package, version, commit, expected, actual}` | a composed package's tree at the locked commit does not digest to the lock's `integrity` (`expected`); `actual` is the digest read. Preview and apply, before anything is written ([The integrity check at spawn](packages.md#the-integrity-check-at-spawn)) |
| `E_SLOT_CONFLICT`, `E_SKILL_DUPLICATE` | | the composition conflicts |
| `E_WORKSPACE_SCHEMA` | `{path, key, reason}` | a removed key or invalid payload |
| `E_CLONE_MISSING`, `E_CLONE_MISMATCH` | | the member's clone is missing or wrong |
| `E_CHILD_SPAWNS_DISABLED` | `{parent, policy}` | the parent's policy is off |
| `E_PARENT_NOT_FOUND`, `E_RELATIVE_NOT_FOUND` | | the anchor name matches no instance |
| `E_RELATIVE_AMBIGUOUS` | | the anchor matches several instances (`--relative-root` picks one) or a same-named instance would shadow the edge |
| `E_BRANCH_EXISTS`, `E_BASE_UNKNOWN` | | |
| `E_INSTANCE_NAME_INVALID`, `E_INSTANCE_NAME_TAKEN` | see above | |
| `E_DECISION_STALE` | `{decision}` | |
| `E_PLACEMENT_TAKEN`, `E_IDEMPOTENCY_CONFLICT` | `{instance, home}` | |
| `E_SPAWN_INCOMPLETE` | `{instance, home, launched, unconfirmed: true}`; retained launch-prompt outcomes additionally carry `{retained: true, target, parentLineageCommitted, launchPrompts}` | See [launch prompt results](#launch-prompt-results). |
| `E_LAUNCH_*`, `E_MODEL_UNKNOWN`, `E_UNSUPPORTED_HARNESS` | | the launch selection is refused |
| `E_HARNESS_UNAVAILABLE` | `{harness, from, at, fix}` | the chosen harness has no executable on this machine ([launch preferences](#soul-launch-preferences-feature-launch-preference-oats-0300)) |
| `E_CLAUDE_CONFIG_REMOVED` | `{file, executable, fix}` | a new claude launch with an `oats-claude-config` in reach ([configuration.md](configuration.md)) |
| `E_CLAUDE_LOGIN_CREDENTIAL` | | the effective Claude configuration has a `/login` credential file while OATS sets `CLAUDE_CODE_OAUTH_TOKEN`; remove the login credential and use the token route ([configuration.md](configuration.md)). Spawn preflight checks predictable values before effects, and the actual pane is checked after hooks |
| `E_HARNESS_RESOURCE_MISSING` | | a harness package a capability requires for the selected harness is not installed, disabled, or cannot be verified ([capabilities.md](capabilities.md)); raised before any home exists, at a preview too, and again by an apply after the home, the work and the hooks when the pane it got differs from the one it checked in a name the probe reads, or selects another program (another creator started the OATS tmux server): then the spawn is rolled back, with `details.unconfirmed` when that cannot finish. A start, a restart and a launch plan's `harness-packages` check answer the same code |
| `E_LAUNCH_SHIM` | | the home's `oats` (`<home>/.oats/bin/oats`) cannot be written; the spawn is rolled back |
| `E_SCHEDULE_INVALID` | | a bad wake (`--wake-json`, `--wake-file`, `--wake-*`) |
| `E_INTERRUPTED` | `{signal, hooks}` | SIGINT, SIGTERM or SIGHUP while the spawn's `worktree` hooks ran (feature `worktree-event`): the running hook's process group is ended, the spawn is rolled back as for a required hook failure, and the process exits 128 + the signal number |
| `E_REQUIRED_HOOK_FAILED` | `{hooks}`, plus `unconfirmed: true` when compensation cannot finish | a required `spawn` or `worktree` hook failed or timed out; the spawn is rolled back. `hooks` holds the receipt of the event that failed: one entry per hook that ran, `{capability, ok, required, log, exitCode?, signal?, timedOut?, contract?}`, paths only. `log` is `null` for a spawn hook (it keeps no log) and once the rollback removed the home; a retained home keeps a `worktree` hook's log path. Never `home`. Before 0.49.0 a required spawn hook's failure answered `E_SPAWN_FAILED` |
| `E_HOOK_ENVIRONMENT_CONTRACT` | the same as `E_REQUIRED_HOOK_FAILED`, the failed entry with `contract: "environment"` | a `spawn` hook answered an `env` its manifest does not allow, or a `worktree` hook answered `env` at all |
| `E_RUNTIME_ENDPOINT_UNKNOWN` | | the session cannot be established: the OATS tmux server cannot be read at an apply (before any effect, or after the home, the work and the hooks), or the pane's `PATH`, `HOME` or harness folder cannot be read for the harness package check ([the checks read the pane](execution-targets.md#the-checks-read-the-pane)), before anything is probed or created, or at the apply's second check after the hooks, as for `E_HARNESS_RESOURCE_MISSING`. Once the home exists the spawn is rolled back, with `details.unconfirmed` when that cannot finish. A start and a restart answer the same code |
| `E_SPAWN_FAILED` | `{unconfirmed: true}` when compensation cannot finish; `cause` for an error with a system code, or a defect | an error with no kernel code |

Spawn failure envelopes carry `error.details.unconfirmed: true` when an existing
keyed spawn is incomplete (`E_SPAWN_INCOMPLETE`) or compensation cannot confirm
cleanup. The keyed-spawn details retain `instance`, `home` and `launched`.
Confirmed completed compensation does not set this marker. This is an additive
producer migration; existing text-based compatibility checks remain.

<a id="oats-worktree"></a>
### `oats worktree`

Feature `worktree-event` (OATS 0.49.0). An instance's extra trees,
`<home>/.work-<purpose>`, made and removed from its home
([extra trees](souls-and-instances.md#extra-trees)). There is no `--home`,
`--dir` or `--server`: the home is `$OATS_INSTANCE_HOME` (or `$OATS_HOME`),
else the home enclosing the working directory.

```text
oats worktree add --purpose <p> --branch <b> --base <remote-branch> [--repo <member key|clone path>] [--preview] [--json]
oats worktree remove --purpose <p> [--json]
```

`add` creates the tree with Git, fires the `worktree` hooks
([the worktree event](capabilities.md#the-worktree-event)), writes
`<home>/.oats/trees/<p>.json` and appends a `worktree-added` event. It can run
for minutes; the hooks' output goes to stderr, and stdout holds only the
envelope. A reader that closes either pipe early only stops reading: the add
runs to its end (and its record to `ready`), the hooks' logs are whole, and
what could not be printed is dropped. Its result:

```json
{"purpose":"docs","path":"/w/agents/dev/instances/dev-1/.work-docs","clone":"/w/docs","remote":"https://github.com/nw/docs.git",
 "member":"github.com/nw/docs","branch":"agents/dev-1-docs","base":"main","baseOid":"9f2c41d0…","state":"ready",
 "hooks":[{"capability":"nw-setup","ok":true,"required":true,"log":"/w/agents/dev/instances/dev-1/.oats/logs/worktree-docs-nw-setup.log","exitCode":0}],
 "record":"/w/agents/dev/instances/dev-1/.oats/trees/docs.json","resumed":false,"warnings":[]}
```

- `remote` never carries credentials; `member` is a member key or `null`.
- `resumed: true`: a `ready` record with the same clone, branch and base was
  found; nothing ran, and the result is the recorded receipt.
- `treeMissing: true` appears when a non-required hook removed or moved the
  tree.
- `--preview` fetches and writes nothing: `{preview: true, purpose, path,
  clone, remote, member, branch, base, record, resume, hooks}`, `resume`
  being `null` or `"recover"` (an interrupted add is rolled back first), and
  `hooks` the hooks that would run, `[{capability, required}]`. When the tree
  is already made, it is the recorded receipt with `preview: true`,
  `resume: "noop"` and `hooksToRun: []`.

`remove` answers `{purpose, path, removed: true, rolledBack, branch,
branchKept, branchKeptReason?, warnings?}`. After removing a `ready` tree,
`rolledBack` is `false` and `branchKept` is `true`. When an instance whose
session is stopped was [attached](souls-and-instances.md#extra-trees) to the
removed tree, `warnings` carries one string for it: `<instance>: its work
was <tree>, which was removed; its work link <home>/work now points at a
path that is gone`. With no attached instance the answer is what it was. When it completed an
interrupted add's rollback, `rolledBack` is `true` and `branchKept` says
whether the branch still exists. The rollback deletes the branch only when
that add created it, no worktree has it checked out, and it still points at
the commit the add created it at. A branch kept for one of those reasons is
named in `branchKeptReason`, and is not debt.

The rollback signals a hook process group that the interrupted add left only
when the group's leader is alive with its recorded start time. A group whose
leader has exited is never signalled, because its id may already belong to
an unrelated group. Instead `warnings` names it, so that leftover processes
can be ended by hand.

Every `add` or `remove` that reads a record it may act on holds the
purpose's claim, `<home>/.oats/trees/<purpose>.lock`. The claim is a file
that names its holder by pid and start time. A second command waits up to
3 s for a live holder, then answers `E_LIFECYCLE_BUSY` (`details.lock`,
`details.pid`, and [`details.holder`](#busy-holder) on this and on every
other `E_LIFECYCLE_BUSY` of these commands: OATS 0.52.0): `another oats
worktree add or remove of purpose <purpose> is running (pid <pid> holds
<lock>); nothing was done — retry when it has finished; if it does not end,
check that pid by hand, and if it is not an oats worktree command, remove
<lock>, then retry` ([a live process](#busy-holder-running), not a verified
command). A claim whose holder has died, for example one killed in the
middle of a recovery, is taken over by the next command. So a killed `add`
or `remove` can always be run again. A holder that has exited or was killed
and that its parent has not reaped (a zombie) has died: its claim is taken
over, and a `creating` record whose adder is a zombie is recovered, without
waiting for that reap (0.52.0, #870).

Two files at the claim's path are never taken over and never removed
(0.52.0, #874). The command answers `E_LIFECYCLE_BUSY`, in one line that
names the file, says that nothing was done and never says that a command is
running: at once for a file it has read, and for a path that exists and
reads as absent after its 3 s wait and five more attempts, 50 ms apart; `details.lock` is the file the
message names (for the claim of a takeover, `<lock>.reclaim-<nonce>`):

- A path that is no readable claim: a file that does not parse, a directory,
  or a path that exists and cannot be read, such as a dangling symbolic link.
  `<file> is not a readable claim; nothing was done — inspect it and remove
  it if no oats worktree command holds it, then retry`.
- A claim whose holder is gone and that this kernel cannot take over: its
  `nonce` is not the 32 hexadecimal digits a claim carries (a file written
  or damaged by hand); or it is the claim of a takeover that died, at the
  end of a chain of them so long that the system will not name the claim of
  one more (each adds 41 bytes to the file's name: four or five on a file
  system whose names are 255 bytes at most). `the process that held <file>
  (pid <pid>) is gone, and this file is not a claim this kernel can take
  over (<why>); nothing was done — inspect <file> and remove it if no oats
  worktree command holds it, then retry`. Removing that one file lets the
  next command take the rest over.

A claim that is taken again and again by commands that die is neither of
those (0.52.0). A command takes over the claim of a holder that is gone and
tries again. Once its 3 s are over, when it has found the claim without a
live holder five times and each time found it taken again, the last time by
a process that is gone, it answers `E_LIFECYCLE_BUSY` with `holder: "none"`:
`the claim <file> was found without a live holder 5 times and was taken
again each time, the last time by a process that is gone (pid <pid>);
nothing was done — run the command again`. Nothing is wrong with that file
and nothing is to be removed: the next run takes it over.

A killed parent does not take its running git with it. So every git step
that changes a tree, a ref or the worktree list runs in its own process
group, and is recorded (pid and start time) before it starts: in the claim,
or for an `add`'s own steps, in the tree record. A takeover or recovery
first ends a recorded git step that still runs, signalling it only while its
leader runs with the recorded start time (SIGTERM, which git answers by
removing its lock files, then SIGKILL). Only then does it act, so a dead
command's git never finishes late on a tree or branch made after it. A git
step that times out is cleared from the record only once its whole process
group is gone. A git step that cannot be ended keeps the claim, or the
record, and the command answers `E_LIFECYCLE_BUSY`.

`E_LIFECYCLE_BUSY` says that nothing was done, so it is never answered once
a takeover has ended a dead command's git step (0.52.0). A command that
ends such a step and is then refused the claim (another command took it
first, it is held again by a process that is gone, or the system refuses
it) answers `E_LIFECYCLE_FAILED`. Its message names the group it ended
first, then the refusal it met, with "nothing else was done": `git process
group <pgid>, left running by a killed oats worktree command, was ended;
after that: <the refusal>`. `details` are that refusal's own. Run the
command again: nothing of that step is left to end.

A recorded hook group or git step that still has members while its leader's
start cannot be read (where `ps` fails) is never signalled and never passed
over: the leader may still be that hook or git step. The command answers
`E_LIFECYCLE_BUSY`, keeping the claim or the record and touching nothing
else. Its message names the group, its recorded start, why the start cannot
be read and the way out: check the group by hand; if it is that step, end it
(`kill -TERM -- -<pgid>`) and retry; if it is not, remove the claim or the
record it names (a record with what that add left) and retry. A claim's refusal
carries `details.gitPid` and `details.gitStart`.

A failed `add` reports the same facts about its rollback in `details`:
`rolledBack`, `branchKept`, `branchKeptReason` and `warnings`.

| Code | When |
|---|---|
| `E_BAD_ARGS` | not run from an instance home; `--dir`, `--home` or `--server`; a missing value; a value starting with `-`; an invalid purpose, branch or base; `remove` of a purpose with no record (a tree made with raw Git is removed with `git worktree remove`) |
| `E_INSTANCE_RETIRING` | `add` in a quarantined home; in one for which a self-retire is scheduled; or in one whose retire is running (OATS 0.52.0: `add` reads the home's claim and takes nothing; `<instance> is being retired (pid <pid>, since <at>); no tree was made — if it does not end, check that pid by hand, and if it is not an oats retire, remove <lock>, then retry`, `details: {instance, home, lock, pid, since, action: "retire"}`; [Commands that meet on one home](#lifecycle-pairs)) |
| `E_CLONE_MISSING` | the repository is not found, or is not a Git repository |
| `E_CLONE_MISMATCH` | the path is a linked worktree, or the clone has no `origin` |
| `E_BRANCH_EXISTS` | the branch exists in the clone (before the tree is made, or made by another `add` at the same moment); `details.remedy` is `<instance>/<branch>` |
| `E_GIT_FAILED` | a Git step failed on its own (`git worktree add`, or `git switch` while the branch does not exist), with Git's message: `git <sub> failed in <dir>: …`; the tree is removed |
| `E_PLACEMENT_TAKEN` | a `ready` record with another clone, branch or base (`details.differ`); `.work-<p>` with no record, or a file or symbolic link there; an unreadable record |
| `E_LIFECYCLE_BUSY` | an add of that purpose is still running (pid and start time verified); another add or remove of that purpose holds its claim (`details.lock`); a file at the claim's path is no claim this kernel can read or take over (`details.lock`); the claim was taken again, the last time by a process that is gone, each of the five times the command found it without a live holder (`run the command again`); an interrupted add's rollback could not be completed (`details.owed`; the message says what to deal with and to run `oats worktree remove --purpose <purpose>`, which finishes the rollback); or, `add` only (OATS 0.52.0), the home's claim is held by a retire whose liveness cannot be read, or is a file that is no readable claim (`no tree was made`; [Commands that meet on one home](#lifecycle-pairs)). Every one carries [`details.holder`](#busy-holder) |
| `E_REMOTE_UNREADABLE` | the fetch of `<base>` from `origin` failed; the tree is removed |
| `E_BASE_UNKNOWN` | the new HEAD is not the fetched commit; the message names both |
| `E_REQUIRED_HOOK_FAILED`, `E_HOOK_ENVIRONMENT_CONTRACT` | a required `worktree` hook failed or timed out, or a hook answered `env`; the tree is removed (`details.hooks`, `details.rolledBack`) |
| `E_INTERRUPTED` | SIGINT, SIGTERM or SIGHUP while the hooks ran; the tree is removed and the process exits 128 + the signal number (`details.signal`) |
| `E_WORKTREE_DIRTY` | `remove`: Git refused a tree with uncommitted or untracked work (`details.git` is Git's message), or an unregistered residue differs from the recorded branch (the message and `details.git` list the modified or nonignored untracked paths). No filter driver the repository's configuration defines is run for either: a file such a filter applies to is compared as its bytes are in the tree. The record is kept. Save the changes, or discard, then retry |
| `E_CHILDREN_RUNNING` | `remove`: an instance attached to the tree has a session that is running, or that cannot be read. Answered under the purpose's claim, before Git is asked anything: nothing is removed and the record is kept. `details: {purpose, path, children: [{instance, home, session}]}`, `session` being `"running"` or `"unknown"`; only the instances that refuse are listed. The message names each one and what was seen, and the step: `oats instance stop <instance>`, or retire it, then remove again. No flag removes anyway. It is the code [a retire](#retire-children-running) answers, with other `details`: a retire answers it for a child it asked to stop and that did not; `remove` for an attached instance it found running or unread, and it asks nobody to stop, so there is no `childrenStopped` |
| `E_WORK_PRESERVATION_FAILED` | `remove`: Git refused for another reason, removal could not be verified, an unregistered residue could not be checked against its recorded branch or deleted, or the repository's configuration defines a filter driver whose name cannot be overridden on Git's command line (it holds `=` or is not UTF-8; Git is not run on the tree, since it would run that filter: [filter drivers](souls-and-instances.md#retire-filter-drivers)); the record is kept. A failure after Git started removal reports possible partial deletion and the retry, never that nothing was removed. A missing or invalid `.git` marker names the manual step: save any work, remove the directory by hand, then run `remove` again to drop the record. See [extra-tree removal recovery](souls-and-instances.md#extra-trees) |
| `E_LIFECYCLE_FAILED` | an error that is not the kernel's; with [`details.cause`](#kernel-codes) when it has a code of its own or is a defect, and without it when it is a refusal without a code. When it is the purpose's claim that could not be taken (`<home>/.oats/trees` cannot be made, the claim's file cannot be written), the message is `the claim <path> could not be taken (…); nothing was done`. Also a command that was refused the claim after its takeover had ended a dead command's git step: the message names the group it ended first, then the refusal, and `details` are that refusal's (a refusal of the kernel's has no `details.cause`; anything else has it by the same rule) |

A rollback that cannot finish keeps the record and says so in the message
(`details.rolledBack: false`, `details.owed`); the next `add` or `remove` of
that purpose finishes it.

## `instance.json` and the roster

<a id="instancejson"></a>
### `instance.json`

Written by the spawn; read by the roster and every `--home` command. The
workspace-model fields (feature `instance-modules`):

```json
{"agent":"rm","kind":"persistent","instance":"rm-api","home":"/w/agents/rm/instances/rm-api","soulDir":"/w/agents/rm/souls/66566512168e",
 "repo":"/w/agents-repo","work":"worktree","branch":"agents/rm-api","base":{"ref":"github.com/nw/agents","oid":"66566512…"},
 "harness":"pi","modelFrom":"harness-default","spawnOrigin":"operator",
 "policy":{"childSpawns":{"allowed":true,"origin":{"kind":"default","detail":"no spawn option: children allowed"}}},
 "modules":{"oats.okf":{"from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"},
                        "commit":"ab897841…","digest":"sha256-9a0e…","materializedAt":"2026-09-28T10:08:01.100Z"}},
 "providers":{"oats.okf":{"owns":"rm","state-dir":"/Users/ana/.oats/okf"}},
 "workspace":{"key":"github.com/nw/agents","name":"northwind","deployment":"/w","commit":"66566512…","resolution":"abacbdb5a7975098d77007c8","standalone":false,
              "soul":{"id":"github.com/nw/agents#rm","repoKey":"github.com/nw/agents","commit":"66566512…"},
              "layers":{"knowledge":{"capability":"oats.okf","from":"workspace"},"messaging":null,"tasks":null}},
 "teams":[{"label":"mine","team":"mine:ana.aweb.ai","default":false,"from":"local"}],
 "defaultTeam":{"label":"eng","team":null,"from":"soul"},
 "capabilities":[{"id":"oats.okf","layer":"knowledge","command":"okf","origin":"package:oats.okf@2.1.3","level":"/w/agents/rm/instances/rm-api",
                  "settings":{"owns":"rm","state-dir":"/Users/ana/.oats/okf"},"settingsOrigins":{},"provenance":["package oats.okf v2.1.3"],
                  "skills":["/w/agents/rm/instances/rm-api/.agents/skills/oats.okf/okf"],"hooks":["retire","spawn"],"trusted":true}],
 "skills":[{"name":"release-checklist","source":"soul"},{"name":"okf","source":"module:oats.okf"}],
 "createdAt":"2026-09-28T10:08:01.281Z"}
```

Abridged: the record also carries the launch recipe and command,
composition evidence, the capability runtime, the tmux target,
lineage (`parentInstance`, `siblingInstance`, `relation`, `relativeTo`), and
the keyed-spawn fields `decision`, `spawnIdempotencyKey`, `spawnCompleted` and
`wake`; later starts add `restarts` and `restartCount`.

- `modules.<cap>`: `{from, commit, digest, materializedAt}`; `digest` hashes
  the copy at `<home>/.oats/modules/<cap>/`. Module skills are copied flat to
  `<home>/.agents/skills/<skill>/` (homes spawned by 0.30.1 or earlier keep
  `<home>/.agents/skills/<cap>/<skill>/`).
  After a package upgrade, the moved row also carries
  `previous: {from, commit, digest, materializedAt, receipt}`: one level, for
  its latest move. Readers tolerate this additive field. The verified copy
  for undo lives at `<home>/.oats/previous/<receipt>/`; each move replaces the
  previous state, and retirement preserves it in recovery.
- `branch`: for a worktree instance, the branch its worktree was created on.
  For an attached or checkout instance, the branch the tree's HEAD named at
  the spawn, or `null` when HEAD was detached or named a ref OATS carries no
  branch name for (one whose name is not valid UTF-8); never the word
  `"HEAD"`. The key is absent when the tree's HEAD could not be read, and for
  directory and workspace instances. A home spawned before 0.49.0 may record
  `"HEAD"` for a detached tree; [`oats instance git`](#instance-git-state-oats-instance-gitdiff-instancegitapi-1-oats-0247)
  reads it as no recorded branch. The roster row and the spawn result carry
  the same value (the spawn result has `null` where the key is absent).
- `base` (a worktree instance): `{ref, oid}`, the commit its branch started
  at, as the spawn result states it (see Placement under the spawn preview).
- `providers.<cap>`: the merged payload (`{}` when none).
- `workspace`: `{key, name, deployment, commit, resolution, standalone, soul,
  layers}`. `name` is recorded, and every hook, command and operation of the
  home receives it as `OATS_WORKSPACE_NAME`. `soul.id` is `<repoKey>#<soul>`,
  or `package:<id>#<soul>` for a package soul, which also records `name`,
  `qualifiedName` and `package: {id, version, commit, digest, path}`.
  `layers.<slot>` is `{capability, from}` or `null`. A standalone spawn
  records `standalone: true` and the member's key.
- `teams` (mapped rows, as the providers received them) and `defaultTeam`
  are never rewritten.
- `soulDir` is the soul the instance incarnates; hooks receive it as
  `OATS_SOUL`. Homes carry no `soul` link.
- `modelFrom`: see the roster. `trigger` (a triggered instance): `{id, key,
  source, repo, number, url, event, headSha, observedAt, eventFile}`.
  `capabilityMeta.<cap>.identity`: the served identity a provider recorded.

<a id="the-roster-oats-status---json"></a>
### The roster (`oats status --json`)

```text
oats status [--dir <d>] [--max-age <s>] --json
```

Not an envelope: `{root, agents, observation?, features, workspace?, problems?, warnings?}`
(`observation` only with [`--max-age`](#observation-reuse-feature-observe-max-age-oats-0311)).
It carries no `schemaVersion`: a remote caller recognizes the bare roster by
its absence.

```json
{"root":"/w/agents",
 "agents":[{"name":"rm","description":"Cuts releases.","work":"worktree","kind":"persistent","dir":"/w/agents/rm",
            "soulSource":{"repoKey":"github.com/nw/agents","commit":"66566512…","path":"souls/rm","current":"66566512…","status":"current"},
            "instances":[{"agent":"rm","instance":"rm-api","home":"/w/agents/rm/instances/rm-api","harness":"pi","launched":true,
                          "createdAt":"2026-09-28T10:08:01.281Z","modelFrom":"harness-default","startedAt":"2026-09-28T10:08:01.281Z","identityAddress":null,"running":true,
                          "modules":[{"name":"oats.okf","from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"},
                                      "commit":"ab897841…","current":{"commit":"ab897841…","version":"2.1.3"},"status":"current"}],
                          "soul":{"repoKey":"github.com/nw/agents","commit":"66566512…","current":"66566512…","status":"current"}}]}],
 "features":["retire-home","session-start","…","server-probe-features"],
 "workspace":{"reachable":true,"key":"github.com/nw/agents","ref":"git:github.com/nw/agents","keyFrom":"workspace","standalone":false,"defaultTeam":{"label":"eng","team":"eng:nw.aweb.ai"},
              "teams":{"eng":"eng:nw.aweb.ai","mine":"mine:ana.aweb.ai","ops":null},"teamsFrom":"observed"}}
```

- **Agent rows**: the soul's recorded definition plus `dir` and `instances`,
  and (feature `launch-preference`) `key`: the soul key, as on
  [soul rows](#oats-capabilities-and-oats-souls), or `null` when no instance
  records a workspace soul;
  `soulSource` (`{repoKey, commit, path, current?, status?}`, `current` or
  `moved`) for a workspace soul; `retireFailures[]` (`{instance, completedAt,
  error, incomplete, retry, resultPath}`) when a deferred self-retire failed.
  An entry stays until a retire of the instance completes or its result
  file is removed by hand, whether or not the instance's row still has
  `retirePending`
  ([a completion that does not complete](souls-and-instances.md#self-retire-not-completed)).
  A capability agent's row is `{name, kind: "capability", capability,
  description, dir, instances}`.
- **Instance rows**: the home's `instance.json` (launch recipe and command
  redacted) plus `home` and `instance` (from the directory; a disagreeing
  claim is kept as `recordedHome`/`recordedInstance`), `running` (read from
  the row's recorded tmux socket and session, never the caller's `$TMUX`;
  `true` means the harness is running, using the same pane and shell-descendant
  rule as session inspection. A fallback shell is `false` with `runtimeState:
  "shell"`, even though the window remains; a dead pane or absent window is
  `false`. A wrapper shell with a live non-shell descendant stays `true`.
  `false` for a shell needs positive evidence: the process table holds the
  pane's own process as a shell and no non-shell process below it
  ([#1641](https://github.com/awebai/oats/issues/1641)); a table that cannot
  establish that reads `null` with the reason as `runtimeError`: one without
  the pane's process (a `ps` in another PID namespace, a pane respawned since
  tmux answered), one with a process in the pane that has no command name, or
  one with a line that is not a process when nothing non-shell was found.
  `null` with `runtimeState: "unreachable"` and the tmux error as
  `runtimeError` when that server or its panes cannot be read (including a
  window where OATS cannot tell which pane is the agent's
  ([which pane is the agent's](execution-targets.md#which-pane-is-the-agents)),
  a session with two windows of the instance's name, or a failed or
  inconclusive shell-descendant process scan; a window whose agent's pane is
  found reads by that pane alone), and also when its socket
  file is missing while a process works in the home or the process scan
  cannot run, `runtimeError` then naming the processes or the scan's error
  ([#624](execution-targets.md#missing-socket); with no process in the home
  a missing socket file reads `false`, as after a reboot); `null` for a home a
  Herdr-era kernel recorded, with `runtimeState: "unsupported"` and
  `runtimeError: "E_HERDR_REMOVED: …"`, the recorded `sessionTarget` staying
  in the row),
  `identity` when a provider recorded one, `rollbackIncomplete`,
  `retirePending` and [`retire`](#row-retire) when present, and the Desktop
  facts below.
- <a id="unreadable-record-row"></a>**A home whose `instance.json` cannot be
  read** (OATS 0.52.0) is listed like every other, and one such home never
  fails the listing. Its row has the fields of a home with no `instance.json`
  and nothing from the record: `instance`, `home`, the Desktop facts
  (`startedAt`, `identityAddress`, `modelFrom`, `attributedHuman`, each `null`), `waitingOnYou:
  null`, `rollbackIncomplete` and `retirePending` when present, and `running:
  null` with `runtimeState: "unreachable"` and `runtimeError:
  "E_UNIDENTIFIED_INSTANCE_HOME: <home>/instance.json cannot be read
  (<reason>)"`. The reason is the system's (`EACCES: permission denied`), the
  parser's (a file cut off, or empty), or what the file is instead: a
  directory, a symbolic link to nothing, JSON that is not an object. A home
  with no `instance.json` keeps its row: the same fields, `running: false`
  and no `runtimeState`. What the lifecycle commands answer for such a home:
  [below](#unreadable-record).
- **`spawnInProgress`** (feature `worktree-event`, OATS 0.49.0): `true` only
  while a spawn that is running its `worktree` hooks is verifiably alive (its
  pid runs with the recorded start time). Such a home holds the quarantine marker
  with an `inProgress` field ([capabilities.md](capabilities.md#manifest)),
  and its row carries `spawnInProgress: true` and **no**
  `rollbackIncomplete`: a live spawn, not a failed one. Once that process is
  gone, or when its start time cannot be read (where `ps` fails), the row
  carries `rollbackIncomplete` as for any quarantine, its `inProgress` naming
  the pid; retire still refuses an unreadable one with `E_LIFECYCLE_BUSY`
  until `--force`. A spawn whose process has exited or was killed and that
  its parent has not reaped (a zombie) is gone (0.52.0, #870): its row
  carries `rollbackIncomplete`, where before it read `spawnInProgress: true`
  until the reap, and retire completes it. Absent otherwise, and from older
  kernels.
- **`waitingOnYou`** (feature `waiting-on-you`): `{since, producer, reason,
  message}` when the row is `running: true` and a producer holds a live claim
  that the instance needs input from a human, else `null` (unknown, not "not
  waiting"). Its rules are the events read's ([Waiting on you](#waiting-on-you)):
  one bounded read of the home's log per running row. A remote roster row
  carries what the remote kernel reports; an older kernel omits the field.
  From OATS 0.60.0 `running` is the harness's liveness, so a fallback shell
  or a retained dead pane already reads `running: false` and carries no
  claim; the claim still needs the home's session receipt to name a target.
  An older kernel's `running` is the window's presence, and it checks a row
  with a claim against its session (as `oats session inspect` observes it),
  reading `null` unless a harness runs there.
- <a id="row-session-end"></a>**`sessionEnd`** (feature `session-resume`, OATS
  0.69): how the last session of a launched home that does not run ended:
  `lost` (the host went down, its tmux server died, the harness was killed
  by a signal, or `oats host run` stopped it because the host was stopping:
  the sweep brings it back when it can vouch for the loss,
  [Which losses come back](execution-targets.md#which-losses-come-back)), `stopped` (stopped with OATS:
  `oats instance stop`, Desktop's Stop, or an `oats session restart` whose
  relaunch did not happen) or `exited` (the harness ended by
  itself: `/exit`, its own error). Present only on a row that reads
  `running: false` and records `launched: true`, a row at its fallback shell
  (`runtimeState: "shell"`) included; absent while it runs or reads unknown
  (`running: null`), for a home never launched, on rows with `retirePending`,
  `rollbackIncomplete` or `spawnInProgress`, and from older kernels. Read
  from the home's current start (`startId`; its time is the last
  `restarts[].startedAt`, else `createdAt`) and two kernel-private files of
  the home, not a contract ([execution-targets.md](execution-targets.md#how-a-sessions-end-is-read)).
  A home spawned before 0.69 and never restarted since reads `lost` when its
  harness ended on its own; its next start covers it.
- **A local status read records what it sees** (feature `session-resume`,
  OATS 0.69): per home, its current start, when it was last seen running and
  first seen not running, with the boot of each, in a kernel-private file of
  this machine, one per deployment, under `~/.oats/session-resume/seen/`
  (`$OATS_HOME_DIR` when set), beside the sweep's per-boot note; it is not a
  contract, and only the sweep reads it. It never changes the answer: not the
  output, not the exit status, and nothing is printed, whether or not it can
  be read or written. A status routed with `--server` records nothing on this
  machine ([execution-targets.md](execution-targets.md#which-losses-come-back)).
- **`color`** (feature `instance-color`): the instance's colour, one of
  `sand`, `sage`, `slate`, `mauve`, `clay`, `olive`, or `null` for none,
  from the home's own record ([An instance's colour](#an-instances-colour-oats-instance-color));
  a `color` in `instance.json` never stands in for it. Every row has it,
  an unreadable record's row included (`null`). Presentation only: it is not
  identity and never addresses anything.
- **`background`** (feature `instance-background`): `true` while the home
  holds a valid background record ([Background instances](#background-instances-oats-instance-background)),
  absent otherwise; never `false`. A `background` in `instance.json` never
  stands in for it. The text rows mark it: `• <instance> [background]`.
- <a id="row-same-work"></a>**`sameWork`** (feature `instance-same-work`):
  `true` when the home's same-work flag
  ([Same work as the parent](#same-work-as-the-parent-oats-instance-same-work))
  is bound to the parent the row's `parentInstance` names. Otherwise the key
  is absent, never `false` or `null`: no flag, a flag bound to an earlier
  parent, no `parentInstance`, and a row whose `instance.json` cannot be read.
  A `sameWork` in `instance.json` never stands in for it. Clients draw the
  parent→child line for a row that carries it; a client that does not know
  the key ignores it, and an older kernel never sends it.
- <a id="row-retire"></a>**`retire`** (feature `status-retire-state`, OATS
  0.59.0): `{state, since, self, code?, message?}` while a retire of the home
  is running, scheduled or owed; absent otherwise, and from older kernels.
  `retirePending` keeps its meaning (the self-retire marker is there) and is
  not replaced. Status only reads: it takes no claim, removes no file and
  signals no process. `self` is `true` when the self-retire marker
  (`.oats-retire-pending-<instance>.json`, [souls-and-instances.md](souls-and-instances.md#self-retire-not-completed))
  is beside the home, whatever the claim says, and `false` for a retire
  another process runs (an `oats retire` holding the home's claim). The
  marker is read first:

  | Beside the home | `state` | `self` | `since` |
  |---|---|---|---|
  | the marker, and the result file `.oats-retired-<instance>.json` with `ok: false` | `failed`, with `code` and `message` | `true` | the result's `completedAt`, else the marker's `requestedAt` |
  | the marker, no failed result, its completion process alive | `running` | `true` | the marker's `requestedAt` |
  | the marker, no failed result, the completion's liveness cannot be read, or the marker names no completion process | `unknown` | `true` | the marker's `requestedAt` |
  | the marker, no failed result, its completion process gone | `interrupted` | `true` | the marker's `requestedAt` |
  | a marker that cannot be read as an object | `unknown` | `true` | the marker file's modification time |
  | no marker; the home's claim held by a retire whose holder is alive | `running` | `false` | the claim's `since` |
  | no marker; the same, the holder's liveness cannot be read | `unknown` | `false` | the claim's `since` |
  | no marker; the claim's holder gone, a stop's claim, or no claim | absent | | |

  A result with `ok: true` beside a marker still there reads as no result.
  `code` is the result's `error.code` when it matches `^E_[A-Z0-9_]+$`, and
  is left out otherwise (the state stays `failed`); `message` is its
  `error.message` on one line and cut to a retire's one-line reason (at most
  2048 UTF-16 code units, a cut ending in `…`), left out when empty: each is
  a string or absent, never `null`, and only on `failed`. `since` is always
  there, an instant as `toISOString()` writes it: the time in the table when
  it is one, else the marker file's modification time (the claim file's for
  a claim); a `retire` whose time cannot be read at all is not given. A
  failed retire that owes the home nothing leaves no marker: its row carries
  no `retire`, and its agent row's `retireFailures[]` holds the outcome, as
  before. A retire that was killed while it held the claim leaves a claim
  whose holder is gone, which reads absent.

  **How the clients read it** (`packages/client/retire-state.mjs`): `since`
  a string, `self` a boolean, `code` an `E_…` code and `message` a string,
  each optional field absent or a string, never `null`. Any other field is
  dropped. A value with any field out of this shape is dropped whole, never
  repaired, and the row reads as if it had none; it never fails the roster.
  `retirePending` is read on its own and kept as reported. The Desktop and
  `oats tui` read `running` and `unknown` as **Retiring…**, `failed` as
  **Retire failed** (its `message` and `code` shown as OATS's words, through
  the display filter) and `interrupted` as **Retire didn't finish**. A row
  with `retirePending` and no `retire` (a kernel without the feature) reads
  **Retiring…**. `rollbackIncomplete` and `spawnInProgress` are read before
  it. A remote roster row's `retire` is read by the same rule
  ([remote rows](#remote-row-retire)).
- **`modules`** becomes drift rows `{name, from, commit, current, status,
  reason?}` when the workspace was read. `status` is `current`, `moved` or
  `missing` (`reason`: `capability-absent`, `package-absent`, or the member's
  unconfirmed reason; `current: null`). `current` is `{commit, version}`
  (`version` on member rows is a Desktop fact). A package module without a
  lock reads `current`.
- **`soul`** is the soul source's drift `{repoKey, commit, current, status,
  reason?}`; a package soul adds `package`, `version`, `currentVersion`
  (`missing` reasons: `package-absent`, `soul-absent`).
- **`workspace`**: `{reachable: true}`, or `{reachable: false, code, reason,
  message}` (modules then stay the recorded map), plus the deployment's
  [workspace identity](#workspace-identity-feature-workspace-identity-oats-0360)
  either way. Absent without `oats-local.yaml`.
- **`features`** (feature `server-probe-features`, OATS 0.49.0): the
  running kernel's own feature list, the same array as `version --json`
  `features`, so a [remote roster](#the-remote-roster-oats-server-roster---json)
  relays a host's features from the status answer it already pulls. It is
  emitted at output time, never part of a reused observation. A kernel
  before 0.49.0 omits it.
- **`sessionViewer`** (feature `session-attach-prefix-scroll`): this host's
  `{prefixScroll}`, as `version --json` answers it, read afresh at each
  run and never part of a reused observation, so a roster relays it from
  the status answer it already pulls.
- `problems`: the legacy-home rows ([dispatch errors](#dispatch-errors)).
  `warnings`: envelope warnings. `--team` is `E_BAD_ARGS` (an envelope).

<a id="workspace-identity-feature-workspace-identity-oats-0360"></a>
**Workspace identity** (feature `workspace-identity`, OATS 0.36.0). The
`workspace` object says which workspace and teams this deployment is, read
offline with no network, so it is there whether `reachable` is `true` or
`false`:

| Key | Meaning |
|---|---|
| `key` | the canonical repo key of the workspace HOST (`parseRepoRef(…).key`: every spelling of one repository gives one key, e.g. `git:github.com/nw/agents`, `https://github.com/nw/agents.git` and `git@github.com:nw/agents.git` all give `github.com/nw/agents`). When `oats-local.yaml` names a member in place of its host, it is the host's key once the member's backlink is known. `null` when `parseRepoRef` refuses the reference |
| `ref` | the reference exactly as `oats-local.yaml` writes it (`workspace:`), for display only |
| `keyFrom` | `"workspace"`: `key` is the host's, because this run observed it, or the cache holds the ref's workspace file, or a member's cached backlink names the host. With nothing observed or cached, the ref is taken as the host, as the schema defines `workspace:`. `"member"`: the ref names a member whose host is not known yet, so `key` is the member's own. `null` with a `null` key |
| `standalone` | `true` only when `oats-local.yaml` sets `standalone:` (the configured standalone view, whose local teams are its whole team model). A run that fell back to the standalone view because the host is unreadable is `false`: its teams are the workspace's, read through the sources below. Unlike `workspace.standalone` on [inspect](#oats-inspect), which is the view a home runs in |
| `defaultTeam` | `{label, team}`: the label is `oats-local.yaml`'s `defaultTeam`, `team` its provider id from `teams` (`null` when that map gives none). `null` when `oats-local.yaml` names no default team |
| `teams` | `{<label>: <provider team id> \| null}`: every team label the deployment maps, local and shared, by label; a label in both is the committed (shared) one, as [`oats teams`](#oats-teams) resolves it |
| `teamsFrom` | where the shared teams came from: `"observed"`, the workspace file this run read; `"cache"`, this machine's cached copy at the host commit it last observed (no git process, no network; when `key` names a member, the host its cached `oats-membership.yaml` names); `"local"`, none: `teams` holds the local teams only |

A configured standalone deployment reads no workspace file, so it is always
`teamsFrom: "local"`, with its local teams only (as spawn resolves them there).
`oats status` only reads the workspace when an instance records modules or a
workspace soul, so an empty deployment answers from the cache, or from local
teams on a host that has not observed its workspace (`oats sync` and
`oats teams` observe it). The cache is the running kernel's own: after an
OATS upgrade it is empty until the host next observes its workspace.

**Matching workspaces across machines.** Two deployments are the same
workspace when their `key`s are equal; `ref` is never compared. The identity
is resolved the same offline way for every deployment, standalone included,
whatever its team view:

- `keyFrom: "member"` is unresolved: never match it, and show it as
  unresolved (the host is learned when the deployment observes its
  workspace, e.g. `oats sync`).
- `keyFrom: "workspace"` with nothing observed (`teamsFrom: "local"` on a
  deployment that is not standalone) means the ref was taken as the host, as
  the schema defines. If it is really a member, the worst case is a split
  (one workspace shown as two until `oats sync` there), never a wrong merge.
- A `null` key is an unusable reference and never matches. Show `ref` with
  "this deployment's workspace reference isn't valid; fix oats-local.yaml".
- Known limit: `parseRepoRef` lowercases the host but keeps the path's case,
  so references that differ in owner or repository case give different keys.

**Matching teams across machines.** This is the rule for comparing two
deployments' teams (as the Desktop does to attach a remote machine to a
workspace):

- `teamsFrom` `"observed"` or `"cache"`: a `null` team is **unmapped**, and
  unmapped matches only unmapped.
- `standalone: true` with `teamsFrom: "local"`: the local config IS the
  complete team model, so a `null` team is **unmapped** (matches only
  unmapped). Reason to show: "teams are local only on this host
  (standalone)", with no sync advice.
- `standalone: false` with `teamsFrom: "local"`: a `null` default team is
  **unknown** and never matches. Reason to show: "this host hasn't observed
  its workspace yet; run oats sync there". A non-null default team (a locally
  mapped team) matches normally.

**Desktop facts** (feature `desktop-facts`): `startedAt` is the last start or
restart, else `createdAt` for a launched home, else `null`. `modelFrom` is
`"soul"`, `"spawn"` or `"start"` (an explicit `--model`), `"launch-config"`,
`"harness-default"`, or `null` for an older home. `identityAddress` is the
messaging identity's `address` (else `alias`), or `null`.

<a id="attributed-human"></a>
**Attributed human** (feature `spawn-attribution`): `attributedHuman` is on
every instance row, the label of the human the instance's messaging identity
is attributed to, or `null`. The messaging capability may record an optional
`attribution` in the served identity it records (`identity`):
`{mode: "human"|"none"|"unknown", human: {id, label}|null, parent: {id}|null}`,
with opaque strings the kernel never interprets. The row reads it by slot,
never by name: only the identity of the capability whose layer is `messaging`
counts. The row's `identity` falls back to any capability that recorded one;
this never does, so no other capability can name a human on a row.
It is the `label` when `mode` is `"human"`, else `null`; an absent
`attribution` is `null` too, never shown as "none". The label is untrusted
text, held to a waiting claim's `message` rule ([Waiting on you](#waiting-on-you)):
one line of 1 to 200 characters with no refused character (a control
character, a line break, a bidi control), else `null`. An omitted `human` or
`parent` is `null`. A malformed `attribution` (an unknown `mode`, a `human` without a
string `id` and `label`, a `parent` without a string `id`) reads as absent and
never fails the row. `identity` on the row and in `oats inspect` carries the
`attribution` as recorded.

<a id="the-remote-roster-oats-server-roster---json"></a>
### The remote roster (`oats server roster --json`)

```text
oats server roster [--server <id>] [--workspace-key <key>]... [--per-target <ms>] [--budget <ms>] --json
```

An envelope; `result` is `{groups, bounds}` (remote `roster`,
[servers.md](servers.md#the-roster-and-harvest)). One group per server id and
route target:

```json
{"id":"build:3f2a…","server":"build","label":"Build box","registrationPresent":true,
 "target":{"sshHost":"build-host","workspace":"/srv/team","oatsPath":"oats"},
 "probe":{"ok":true,"features":["retire-home","session-start","…","server-probe-features"],"sessionViewer":{"prefixScroll":true}},"agentsRoot":"/srv/team/agents",
 "workspace":{"reachable":true,"key":"github.com/acme/team","ref":"git:github.com/acme/team","keyFrom":"workspace","standalone":false,"defaultTeam":{"label":"default","team":"acme:team"},
              "teams":{"default":"acme:team"},"teamsFrom":"observed"},
 "souls":[{"name":"dev","harness":"claude","work":"worktree","agentsRoot":"/srv/team/agents"}],
 "instances":[{"server":"build","instance":"dev-a","agent":"dev","home":"/srv/team/agents/dev/instances/dev-a",
               "agentsRoot":"/srv/team/agents","harness":"claude","backend":"tmux","tmux":{"session":"oats-agents","window":"dev-a"},
               "running":true,"identity":{"alias":"dev-a","address":"acme/dev-a"},"identityAddress":"acme/dev-a",
               "teams":[{"label":"default","team":"acme:team"}],"startedAt":"2026-09-29T10:00:00.000Z","createdAt":"2026-09-29T09:58:12.004Z",
               "model":"opus","runtimeState":null,"parentInstance":"lead","siblingInstance":null,"relation":"child","relativeTo":"lead",
               "spawnOrigin":"instance","work":"worktree","repo":"/srv/team/ws","branch":"agents/dev-a","modelFrom":"soul",
               "soul":{"repoKey":"github.com/acme/team","commit":"66566512…","current":"9c1e04ab…","status":"moved"},
               "modules":[{"name":"oats.okf","from":{"kind":"package","package":"oats.okf","version":"2.1.3","commit":"ab897841…","integrity":"sha256-bada35…","repoKey":"github.com/awebai/oats-okf"},
                           "commit":"ab897841…","current":{"commit":"ab897841…","version":"2.1.3"},"status":"current"}],
               "color":"sage","retirePending":false,"rollbackIncomplete":false,
               "savedRoute":false,"addressable":true,"missingRemotely":false}],
 "retireFailures":[]}
```

- **`probe`**: `{ok: true, features, sessionViewer}` when the host's
  `status --json` was pulled, else `{ok: false, error: {code, message}}`
  (ssh failed or timed out, `E_SSH`; or the host answered `ok: false`),
  with no `features` and no `sessionViewer` key.
  Every group is probed at once, each within its own deadline, so a group's
  `probe` depends only on its own host: one that does not answer in time is
  `E_SSH` with `ssh to <host> timed out: no answer within <n> s`, and every
  other group is unaffected. Before 0.55.0 the probes ran one after another
  against the total budget, and a group the budget did not reach was
  `E_ROSTER_BUDGET`; that code is no longer answered.
- **`probe.features`** (feature `server-probe-features`, OATS 0.49.0): the
  host's kernel features, relayed from the top-level `features` of its
  [`status --json`](#the-roster-oats-status---json), never probed: the roster
  runs no `version --json` and stores nothing. The answer is untrusted, so it
  is relayed only when it is an array of at most 256 entries, each a string
  of at most 64 characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`; then it is
  the host's list as answered (order and any duplicate kept). Anything else,
  even one bad entry among good ones, is `null`: never a filtered list. A
  host before 0.49.0 omits the key, so its group reads `null` too, whatever
  its version. Read it as `Array.isArray(probe?.features)`: not an array
  means unknown; `[]` is a valid answer (a host with no features), not
  unknown.
- **`probe.sessionViewer`** (feature `session-attach-prefix-scroll`): the
  host's `{prefixScroll}`, relayed from the `sessionViewer` of its
  [`status --json`](#the-roster-oats-status---json), never probed. It is
  relayed as a copy of `{prefixScroll}` only when that is a boolean;
  anything else, or a host whose kernel predates the field, is `null`.
  Read it only for a host whose `probe.features` lists
  `session-attach-prefix-scroll`.
- **`workspace`** (feature `workspace-identity`, OATS 0.36.0): the host's
  own `status --json` [`workspace` object](#workspace-identity-feature-workspace-identity-oats-0360),
  relayed verbatim, or `null` when the host reports none (a deployment
  without `oats-local.yaml`, or a failed probe). A host before
  0.36.0 answers the reachability-only object (`{reachable, code?, reason?,
  message?}`) with no identity fields, so the identity is there only when
  the object has a `key` field (which a 0.36.0 host always sends, `null` for
  an unusable reference). It is never derived on this side. It is on the group, not the
  rows, so an empty remote deployment still reports it.
- **Instance rows** relay the host's own `status --json` row: `identity`,
  `identityAddress`, `teams`, `startedAt`, `createdAt`, `model`,
  `runtimeState`, `parentInstance`, `siblingInstance`, `relation`,
  `relativeTo` and `spawnOrigin`, and (relayed from 0.42.1) `work`, `repo`,
  `branch`, `modelFrom`, `soul` and `modules`, and (feature
  `spawn-attribution`) `attributedHuman` and `spawnedBy`, are always present, `null`
  when the host does not supply them (an older host, a fact it never
  recorded, or a saved route the host no longer lists). Each is the
  [local row's](#the-roster-oats-status---json) fact of the same name,
  relayed as the host answered it. Nothing is derived on this side: `repo`
  is a path on the host, never read here, and `soul` and `modules` are the
  host's own drift observation (against its own members and lock), not
  recomputed: `modules` is the drift rows, or the recorded map when the host
  could not read its workspace, as on a local row. `attributedHuman` passes
  the [local row's](#attributed-human) label rule again on this side, and
  `spawnedBy` the [local row's](#spawned-by) shape rule: a value either
  refuses is `null`.
- **`waitingOnYou`** (0.40.2, [Waiting on you](#waiting-on-you)) is on a row
  only when the host's kernel reports it: a row from a host before 0.40.0,
  and a saved route the host did not list, have no such key. Absent means
  "not reported", which is not `null` ("no claim"). When present it is `null`
  or `{since, producer, reason, message}`, passed through the kernel's read
  rule again on this side: a value that is not a claim (no valid `since` or
  `producer`) is `null`, and an unknown `reason` or an invalid `message` is
  `null` inside a claim that still counts. As on a local row, the host
  reports a claim only for a running instance.
- <a id="remote-row-retire"></a>**`retire`** (feature `status-retire-state`, OATS 0.59.0) is on a row only
  when the host's row has the key: a host whose kernel predates the feature,
  and a saved route the host did not list, carry none. When present it is
  passed through the [local row's](#row-retire) rule again on this side: a
  `state` that is not one of `running`, `unknown`, `failed`, `interrupted`, a
  `since` that is not a `toISOString()` instant, a `self` that is not a
  boolean, or a value that is not an object drops the key; a `code` that is
  not a kernel code, a `code` or `message` that is not a string, and a `code`
  or `message` on a state other than `failed` are left out, and `message` is
  cut to the same bound. `oats status --server
  <id> --json` relays the host's answer verbatim, `retire` included, as it
  does every other field.
- **`background`** (feature `instance-background`) is on a row only when the
  host's row has exactly `background: true`; any other value, a host whose
  kernel predates the feature and a saved route the host did not list carry
  none.
- **`sameWork`** (feature `instance-same-work`) is on a row only when the
  host's row has `sameWork: true`, and is then `true`. Any other value, a host
  whose kernel predates the feature, and a saved route the host did not list
  carry no key ([`sameWork`](#row-same-work)). `oats status --server <id>
  --json` relays the host's answer verbatim, `sameWork` included.
- **`sessionEnd`** (feature `session-resume`; relayed from 0.69.5) is on a row only
  when the host's row has the key, with the host's value: a host whose kernel
  predates the feature, a row the host reports without it (one that runs,
  for example), and a saved route the host did not list carry none. Its
  meaning and when the host sends it are the [local row's](#row-session-end).
  A value that is not `lost`, `stopped` or `exited` drops the key.
- **`addressable`** (0.31): `true` for every row the host reports. Routed
  session and lifecycle commands reach it by `--home`, or by name when the
  name is unique on the host ([addressing](servers.md#run-there); a shared
  name is `E_AMBIGUOUS` with `error.details.candidates: [{agent, home}]`). A
  saved-route row the host did not list is addressable only while the host's
  answer is unknown (`missingRemotely: false`). A row the host was reached
  for and did not list (`missingRemotely: true`) is the one
  [`server forget`](#forget-a-saved-route-oats-server-forget---json) is for.
- **`savedRoute`**: the instance was spawned from this machine and has a
  saved route here. Information only; no action depends on it.
- `running` is `null` when unknown; `backend` is `tmux` for a row with a tmux
  target, else `null`; `tmux`, `sessionTarget` (the recorded target of a home
  a Herdr-era kernel opened) and `runtimeError` are as the host reports them.
- **`bounds`**: `{budgetMs, perTargetTimeoutMs, elapsedMs}`. Each group's
  probe may take the smaller of `perTargetTimeoutMs` (`--per-target`,
  default 20 s) and `budgetMs` (`--budget`, default 45 s, the deadline of the
  whole answer); `elapsedMs` is what the answer took, about the slowest
  group's probe. Before 0.55.0 `bounds` also carried `skipped`, the number of
  groups the budget did not reach; it is gone with `E_ROSTER_BUDGET`.

<a id="roster-workspace-key"></a>
**`--workspace-key <key>`** (feature `roster-workspace-key`, OATS 0.56.0,
#1124) narrows the roster to the groups that can belong to the given
workspaces, so a host registered for another workspace, switched off or not,
costs a window nothing. The flag is repeatable and every occurrence counts;
`--workspace-key=<key>`, one argument per key, is the same (`--workspace-key=`
and a value that starts with `--` are `E_BAD_ARGS`).
With one or more keys, a group is probed and returned when:

1. its registration's `workspaceKey` is one of the keys;
2. its registration's `workspaceKey` is not known (absent; `oats server
   check <id>` learns it);
3. it has no registration for its target (`registrationPresent: false`:
   saved routes only, the registration removed or changed to another
   target). Its workspace is unknown, so it is always probed: it holds the
   rows the Desktop offers Forget on (#1131), which no window's filter may
   hide.

A group whose registration names another workspace is neither probed nor
returned, its saved routes under that registration and target with it. A
group is judged by its registration when it has one, so a saved route whose
target differs from the registration's is a group of its own, kind 3. A key
is compared with the registration's `workspaceKey` as a string, the two
spellings of a [moved repository](workspaces.md#moved-repositories) being one:
it is the canonical key a host's `status --json` reports as `workspace.key`,
never parsed as a repository reference. An empty or missing value, or one
with whitespace or a control character, is `E_BAD_ARGS`. `--server` and
`--workspace-key` both narrow. Without the flag the answer is exactly as
above. With it the answer's shape is unchanged (no filter is echoed in it);
only which groups appear changes, and a key that matches nothing leaves the
kinds 2 and 3. In text mode, keys that leave no group print `no remote groups
for the given workspace keys`.

The Desktop reads one roster for all its windows: it passes the workspace key
of every open window's view in one read, member-derived keys included (a
registration records the key its host reports, whatever its `keyFrom`). A key
that is `null`, or one the kernel would refuse, is no registration's: a view
without a usable key adds none. The read is unfiltered when the Desktop has no
window set or no roster answer yet, when a window shows the switcher, when a
view without a usable key holds another machine's deployment (whose
registration cannot then be named), and when no key is usable.

<a id="forget-a-saved-route-oats-server-forget---json"></a>
### Forget a saved route (`oats server forget --json`)

```text
oats server forget <server> --instance <instance> --json
```

It removes this computer's saved route to `<instance>` through `<server>`,
the file under `$OATS_HOME_DIR/remote/<server>/`, and nothing else. It runs
nothing on the host and does not contact it: the home there, if it still
exists, is untouched ([servers.md](servers.md#what-this-machine-keeps)). It
shipped in 0.22.3 with the roster's `missingRemotely`, so every kernel that
reports a gone row answers it; there is no feature name.

An envelope; `result` is:

```json
{"server":"build","instance":"dev-a","home":"/srv/team/agents/dev/instances/dev-a",
 "target":{"sshHost":"build-host","workspace":"/srv/team","oatsPath":"oats"},"forgotten":true}
```

- **`server`** and **`instance`**: the arguments, echoed.
- **`home`**: the instance's home on the host, as the route recorded it.
- **`target`**: the route's target (`{sshHost, workspace, oatsPath, …}`) as
  the route file recorded it, less the `herdrPath` a route written before
  0.31.0 may hold.
- **`forgotten`**: always `true` on success.

A refusal is `ok: false` with `error: {code, message}` only (no `details`,
no `fix`), exit 1, and removes nothing:

- `E_USAGE`: no server id, or no `--instance` value.
- `E_SERVER_INVALID`: the server id is not `^[a-z0-9][a-z0-9-]{0,63}$`.
- `E_BAD_ARGS`: the instance name is not `^[a-z0-9][a-z0-9-]*$`.
- `E_SNAPSHOT_UNKNOWN`: this computer has no saved route for that instance
  through that server id (a second forget of the same row answers this).
- `E_SNAPSHOT_UNREADABLE`: the route file is not valid JSON; the file is
  kept.

The Desktop runs it only for a remote roster row with `missingRemotely:
true`, after a confirmation, with exactly the row's `server` and `instance`
as the arguments. It never shows `home` or `target`, and it reads the remote
roster again after every outcome, a refusal and an unknown one included,
instead of editing the row.

<a id="servers-per-workspace"></a>
### Servers per workspace (feature `servers-per-workspace`)

```text
oats server list [--workspace-ref <ref>] --json
oats server check <id> --json
```

`server list` is an envelope whose `result` is `{file, servers}`; each row is
the registration (`id`, `sshHost`, `workspace`, and `operatorSshHost`,
`oatsPath`, `path`, `label` when set) plus `workspaceKey` (`null` when not known
yet), `target` and `snapshots`. `operatorSshHost` is the optional `--operator-ssh` alias,
joined from `~/.oats/server-operator-routes.json`; it is absent from `servers.json`.
Older kernels never read the separate file;
existing routing and `target` use only `sshHost`. With `--workspace-ref <ref>`,
`servers` holds only the rows whose `workspaceKey` is the canonical key of `<ref>` (`parseRepoRef`; any
spelling of the repository), and `result.unknownWorkspace` lists the ids
whose key is not known; an unparsable ref is `E_REPO_REF`.

```json
{"file":"/Users/me/.oats/servers.json",
 "servers":[{"id":"altair-aweb","sshHost":"altair","operatorSshHost":"altair-operator","workspace":"/Users/me/acme","path":"/opt/homebrew/bin","label":"altair",
             "workspaceKey":"github.com/awebai/ac",
             "target":{"sshHost":"altair","workspace":"/Users/me/acme","oatsPath":"oats","path":"/opt/homebrew/bin"},"snapshots":0}],
 "unknownWorkspace":["build"]}
```

`server check` adds `workspaceKey` (the host's answer, else the recorded one,
else `null`), `workspaceReadable` (`true`, `false`, or `null` when the host
does not advertise `server-connect` or cannot say) and, when it is `false`,
`workspaceReadError: {code, message, reason, hint?}` beside `id`, `target`,
`remote`, `workspaceReachable`, `agents` and `error`. A recorded key the host
contradicts fails the check with `E_SERVER_WORKSPACE_MISMATCH`, `details:
{recorded, reported}`, and the registration is not rewritten. `server add
--json` answers the registration with `workspaceKey` (`null`, and a
`warnings` entry, when the host answered none).

<a id="oats-server-connect"></a>
### `oats server connect` (feature `server-connect`)

```text
oats server connect <id> --ssh <host> --dir </abs/path or ~/path on the host> [--workspace-ref <ref>]
                    [--operator-ssh <alias> | --no-operator-ssh] [--oats <path>] [--path <dirs>] [--label <text>] [--install-oats] [--replace] --json
```

An envelope, `ok: true` whenever no step failed, human steps included
([servers.md](servers.md#connect-a-machine) has what each step does):

```json
{"id":"altair-aweb","ready":false,
 "registration":null,
 "steps":[{"step":"ssh","status":"ok"},
          {"step":"oats","status":"done","detail":"installed @awebai/oats 0.39.0 (was missing)"},
          {"step":"git","status":"needs-human","code":"E_REMOTE_UNREADABLE",
           "detail":"cannot read remote https://github.com/awebai/ac (auth): on macOS a session without a terminal …",
           "remedy":"on altair: on macOS a session without a terminal … (`gh auth login --insecure-storage`, then `gh auth setup-git`), or use an SSH key the session can reach: …",
           "hint":"keychain-non-interactive"},
          {"step":"deployment","status":"skipped","detail":"waits for git"},
          {"step":"register","status":"skipped","detail":"waits for git"},
          {"step":"readiness","status":"skipped","detail":"waits for git"}],
 "human":["on altair: on macOS a session without a terminal … or the desktop login's ssh-agent (point SSH_AUTH_SOCK at it in the shell's startup file)"]}
```

- `steps` is always the six steps `ssh`, `oats`, `git`, `deployment`,
  `register`, `readiness`, in that order. A step is `{step, status}` plus
  `detail` when there is something to say; `needs-human` adds `remedy` (and
  on `git` the error's `code` and any `hint`), in which every command to run
  is a Markdown code span with each argument quoted for a POSIX shell (a
  value from a reference or a host path is always one literal argument), and
  a value in the surrounding text has its backslashes and backticks escaped
  (`` \\ ``, `` \` ``), so the code spans are exactly the commands (a readiness line relays the provider's own wording); `failed` adds `code` and, for
  some codes, `details`. `skipped` steps say `waits for <step>`.
- `registration` is the registration as written or found (`sshHost`,
  `workspace`: the absolute path the host resolved for `--dir`, never `~`;
  `workspaceKey`; optional `operatorSshHost` joined from the separate operator-route file; and
  `oatsPath`, `path`, `label` when set, given or, without `--path`, read from the host user's
  [login shell](servers.md#the-hosts-login-shell-path)), `null` until the
  `register` step has run.
  With `--replace`, an existing operator route is kept unless `--operator-ssh`
  sets it again or `--no-operator-ssh` clears it. `server remove` deletes the
  separate route too. Both files are updated under `servers.lock`.
- `human` lists the remedies of the `needs-human` steps, in order. A
  `readiness` step that needs a human has one line per problem
  (`<souls>: <subject>: <reason>[ → <remedy>]`, plus `readiness not checked
  for N souls: …` when the 60 s budget ran out, or `readiness not checked: the
  host did not list its souls within 60 s; …` when the listing itself did not
  finish); its `remedy` is those lines joined by `\n`.
- `ready` is `true` when no step is `needs-human` or `failed`.
- A `failed` step ends the run: `ok: false`, `error.code` is the step's code
  (`E_SSH`, `E_REMOTE_INSTALL`, `E_SERVER_WORKSPACE_MISMATCH`,
  `E_DIR_NOT_EMPTY`, `E_SERVER_EXISTS`, `E_SERVERS_BUSY`, or the host's own
  code relayed),
  `error.details` is the step's `details` plus `steps`, the steps so far
  (the failed one last). A mismatch at `deployment` has `details: {expected,
  reported, dir}`; at `register`, `{recorded, reported}`.

The host-side read it uses, `oats onboard <dir> [--workspace <ref>] --check
--json`, answers `{check: true, dir, state, workspace: {ref, key, url}, remote}`:
`state` is `absent`, `empty`, `not-empty`, `not-a-directory` or `deployment`;
`remote` is `{readable: true, commit}` or `{readable: false, error: {code,
message, reason, hint?, remedy?}}`. It writes nothing.

<a id="capability-commands-on-a-server"></a>
### Capability commands on a server (feature `capability-route`)

`oats <namespace> <command> … --server <id>` runs `oats <namespace>
<command> …`, the argv as typed minus `--server <id>`, from the registered
workspace directory on the server. With `--json` the host's stdout (its
envelope) is relayed verbatim and the exit status is the host's. When the
host gave no output this side answers one envelope: `E_SSH` (`ssh to <host>
failed running \`oats …\` on server <id>`) or `E_REMOTE_ENVELOPE`, with
`details: {server, status}`; any `--invite` value in the printed argv is
`<redacted>`. `--server` with no value is `E_BAD_ARGS`, an unknown id
`E_SERVER_UNKNOWN`. Stdin is forwarded untouched unless it is a terminal.

<a id="routed-reads-and-plans"></a>
### Routed reads and plans (`--server`, 0.31)

The Desktop's per-instance reads and the lifecycle plans run on the
instance's own machine: the local command, with `--server <id>` added.

| Command | `remote` entry | The host must advertise |
|---|---|---|
| `oats readiness --server <id> (--home <abs> \| --soul <n>) …` | `readiness` | `readiness`, `readinessApi: 2` |
| `oats instance events <name> --server <id> …` | `instance-events` | `instance-events-2`, `eventsApi: 2` |
| `oats instance git\|diff <name> --server <id> …` | `instance-git` | `instance-git`, `instanceGitApi: 1` |
| `oats instance stop <name> --server <id> (--plan \| --apply …)` | `lifecycle-plans` | `lifecycle-plans`, `lifecycleApi: 1` |
| `oats retire <name> --server <id> --plan`, and the guarded apply (`--plan-revision`, `--idempotency-key`) | `lifecycle-plans` | `lifecycle-plans`, `lifecycleApi: 1` |
| `oats instance color <name> (<color> \| --clear) --server <id>` | none | `instance-color` |
| `oats instance background <name> on\|off --server <id>` | none | `instance-background` |
| `oats instance same-work <name> on\|off --server <id>` | none | `instance-same-work` |

- The flags are the local command's. The instance is addressed like every
  routed instance command ([servers.md](servers.md#run-there)): `--home` as
  given, else the name through its saved route or the host's roster, sent
  as `--home`. `--dir` names a directory on the host and travels as is;
  without it the registered workspace is sent (not for `readiness --home`,
  whose home is its own context). A retire plan and its guarded apply take
  `--dir` like the rest; an unguarded `retire --server` refuses it.
- An instance with a saved route is reached through it, registration or not.
  A guarded retire apply whose name the host no longer lists is sent by name,
  so a repeated key gets the host's recorded receipt (or its refusal).
- The host's envelope is relayed unchanged, success or failure: the same
  document the local command answers, with no routing keys added. The
  guarded retire apply is the routed `retire`, whose result carries
  `server` and `target` as before.
- A host that does not advertise the feature and API number is refused with
  `E_REMOTE_INCOMPATIBLE`, naming both and the host's version, before
  anything is sent. A name two homes share on the host is `E_AMBIGUOUS`.

<a id="the-warm-reader"></a>
## The warm reader (`oats reader --stdio`)

Feature `warm-reader`, `readerApi: 1`. A client that polls a deployment can
start one long-lived child, `oats reader --stdio`, and send it the poll's
reads, `oats status --json` and `oats workspace status --json`, over its
stdin and stdout instead of running the CLI for each one. The reader answers
with the kernel's own read code, kept loaded. It is an accelerator of
identical answers: whenever it is absent, refuses, times out or dies, the
client runs that same read through the CLI, unchanged. The decisions are in
the [design record](design/2026-10-29-warm-reader.md).

```text
oats reader --stdio
```

It takes no other argument: bare `oats reader`, or anything else after it,
is `E_USAGE`.

- **Warm code, not warm data.** The reader keeps only loaded kernel code and
  install-derived constants (the kernel's code fingerprint, the parsed JSON
  schemas, the boot id). Every request reads the deployment afresh: instances
  spawned or retired by another process, an edited `oats-local.yaml` or
  lock, a dead session all show in the next answer exactly as in a CLI run.
  `--max-age` reuse is the CLI's own on-disk
  [observation reuse](#observation-reuse-feature-observe-max-age-oats-0311),
  unchanged.
- **Same answer as the CLI.** For an accepted request, `exit` and `answer` are
  what `oats <argv>`, run by the same install with the same environment and
  with cwd = `--dir`, prints and exits with at that moment: the same envelope
  and schema versions, the same error codes and refusals, the same `null` and
  unknown facts. An environment that carries `OATS_RESOLUTION` or
  `OATS_DEPLOYMENT` is one of them: the reader starts, and answers each
  request with the CLI's `E_UNSUPPORTED_MODE`. Anything the reader cannot
  answer that way is a refusal, a frame of its own, on which the client runs
  the CLI: a client cannot tell the warm path from the fallback.

### Starting it and the probe

- `oats version --json` lists feature `warm-reader` and `readerApi: 1` (the
  feature and API number convention). A client starts a reader only when the
  probe it holds lists both.
- The client starts `oats reader --stdio` from the same binary, Node and
  environment it runs its CLI reads with.
- The version rule is the CLI's own: a reader is trusted only when its
  version equals the probe's, which the client has already accepted under its
  normal range. There is no second rule. Remote routes are out: a reader
  answers reads of this machine's deployments only.

### Wire format

UTF-8, one JSON object per line (`\n`), both directions. Frames are told
apart by their keys. A client ignores unknown keys and any line that is no
frame it knows (a request it then misses times out and falls back).

- **Hello** (reader to client, the first line, once every module the reads
  use is loaded, so a hello means ready):

  ```json
  {"readerApi":1,"version":"<the kernel's version>","reads":["status","workspace status"]}
  ```

- **Request** (client to reader), at most 64 KiB a line:

  ```json
  {"id":"<a string of at most 64 characters, or a safe integer>","argv":["status","--dir","/w","--max-age","60","--json"]}
  ```

  Accepted: an argv the kernel's own hot-read classification
  (`lib/hot-reads.mjs`) names as one of `reads`, that includes `--json` and
  an absolute `--dir`. So the flags, [`--flag=value`](#flags) and the
  exclusion of `--help` are exactly the CLI's; `--team` or a bad `--max-age`
  get the CLI's own `E_BAD_ARGS` answer; `status --server` is another read
  and is refused. A relative, blank or missing `--dir`, or no `--json`, is
  refused. Other keys of a request are ignored.
- **Answer** (reader to client):

  ```json
  {"id":"…","exit":0,"answer":{"…":"…"},"stderr":"<text>"}
  ```

  `answer` is the JSON value the CLI prints on stdout, an error envelope
  included. Equivalence is `exit` and `answer`. `stderr`, present only when
  there is some, is diagnostic text (the CLI's stderr for that read),
  informative only, never parsed and outside the equivalence. It is at most
  8 KiB of UTF-8, cut at a character boundary, so that it never pushes an
  answer line over a client's bound.
- **Refusal** (reader to client), never a CLI answer:

  ```json
  {"id":"…","refused":{"code":"E_READER_UNSUPPORTED","message":"…"}}
  ```

  `id` is `null` when the line's id cannot be read. The codes are used only
  here, never in an envelope:

  | Code | When | Then the reader |
  |---|---|---|
  | `E_READER_BAD_REQUEST` | a line that is not a request: not one JSON object, an `id` that is neither a string of at most 64 characters nor a safe integer, an `argv` that is not an array of strings, a line over 64 KiB | answers the next request |
  | `E_READER_UNSUPPORTED` | an argv outside the accepted forms; a `--dir` the reader cannot make its working directory (a removed deployment), which the CLI then answers with its own failure | answers the next request |
  | `E_READER_STALE` | the install changed since the reader started ([The install stamp](#reader-install-stamp)) | refuses every queued request the same way, then exits 0 |
  | `E_READER_DEFECT` | an unexpected failure of the reader | writes the stack to its stderr and exits 1: per-request state may be half reset |

- Answers may arrive in any order: match them by `id`. This kernel answers
  one request at a time, in arrival order.

<a id="reader-install-stamp"></a>
### The install stamp

An install that changed under a reader (an upgrade, a Node upgrade) is never
answered from the old code. The reader takes a stamp of its install before
any of the kernel's own modules load (only the CLI's entry point and three
small modules of Node built-ins load before it), so an install that changes
while the reader starts is seen too:
the install root directory's device and inode; device, inode, size and mtime
of `package.json`, `bin/oats.mjs`, `package-catalog.json`, every file under
`lib/`, `docs/*.schema.json`, each runtime dependency's `package.json`
where it resolves at that moment (a dependency newly installed nearer the
install moves it) and the Node binary (its real path); and the mtime of each
directory under `lib/` and of `docs/` (a file added or removed). It takes the
stamp again when a request starts and again just before that request's answer
is written. Any difference, or a file gone (an npm global update replaces the
package directory; a half-written install reads as changed too), refuses that
request and every queued one with `E_READER_STALE`, and the reader exits 0.
No hashing, no timers, no file watchers. A `PATH` symlink re-pointed at
another install of the same version is invisible to any stamp: the client's
binding of its reader to the probe record it started it for covers it.

### Lifetime

The reader's lifetime is its client's. Its exit and signal handlers are
installed once, at start.

| The reader exits | Status |
|---|---|
| on stdin's end or a read error on it (its client is gone) | 0 |
| on `EPIPE` on stdout | 0 |
| on `SIGTERM`, `SIGINT`, `SIGHUP` | 128 + the signal's number: 143, 130, 129 |
| after `E_READER_STALE` | 0 |
| after `E_READER_DEFECT` | 1 |

A request in flight when the reader ends is not answered, and its read session
is closed on the way out, which kills its `git` children. A reader killed
with `SIGKILL` leaves its `git` process groups to their own timeouts, as the
CLI does. Its stdout carries protocol lines only: anything else written there
goes to its stderr, and no child it runs inherits its stdout.

<a id="reader-working-directory"></a>
### The working directory

The reads read no working directory, but the programs they run by name
(`tmux`, `git`) are found on `PATH`, and a relative or empty `PATH` entry
resolves against the process's working directory, not the deployment's. So
that it resolves as in a CLI run with cwd = `--dir`, the reader changes its
working directory to the request's `--dir` for the read and back to its
install root when the request ends, answered or failed: it never keeps a
deployment directory that may be removed or unmounted. This depends on
answering one request at a time. A reader that answers two at once must first
give each child it runs its own working directory.

### Client rules

- **Start.** Exactly as the client runs its CLI reads: the same realpath'd
  binary, the same Node, the same environment, no shell. Stdin and stdout
  piped, stderr ignored or drained with a bound (an undrained pipe would
  block the reader). Reads issued before the hello arrives go to the CLI: no
  tick waits on the reader's start.
- **Trust.** Only after a hello, within the CLI read's timeout, with
  `readerApi === 1`, a `version` equal to that of the probe that gated it,
  and the read in `reads`. A mismatch: end the reader and use the CLI until
  the client's probe changes; no retries. A reader is bound to the probe
  record it was started for: a read under another record ends it, and the
  next one starts for the new record.
- **What goes to the reader.** Background reads (`--max-age` above 0). Live
  reads (`--max-age 0`: after a mutation, an admission, a probe change) go to
  the CLI, so they never queue behind the reader's one-at-a-time answers.
- **Refusals.** `E_READER_UNSUPPORTED` or `E_READER_BAD_REQUEST`: that read
  goes to the CLI, and the reader is kept. `E_READER_STALE`: the install
  changed; the read goes to the CLI, the client probes again and starts a
  fresh reader on a later tick (not counted as a failure). A client that
  never probes again uses the CLI for the rest of its session.
- **Failures**, which count toward giving up: an exit without an answer, a
  hello timeout, a request timeout, `E_READER_DEFECT`. The reads in flight go
  to the CLI; a new reader starts on a later tick with backoff (1 s, doubling
  to 5 min); after 5 consecutive failures without an answer, the CLI until
  the client's probe changes, or until its session ends.
- **Timeout.** A request's deadline is the CLI read's own timeout, counted
  from when it becomes the oldest unanswered request: time in the queue does
  not count.
- **Answers.** The client bounds the raw answer line by the CLI read's output
  limit before parsing it, parses it once, and passes `answer` and `exit`
  through the same validation as the CLI's stdout and exit status: an error
  envelope with a nonzero `exit` is handled exactly as from the CLI. The
  reader's stderr, the answer's field and its own, is never forwarded, as
  the CLI read's stderr is not. A client never
  treats the reader as authority beyond what the same CLI read would be.
- **End.** The app ends its reader when it quits: closing its stdin is
  enough, and `SIGTERM` works too. The reader's lifeline is the app's
  exclusive hold of its stdin: the app's death closes it.

<a id="instance-git-state-oats-instance-gitdiff-instancegitapi-1-oats-0247"></a>
## Git and diff

Feature `instance-git` (`instance-git-remote` for `remote`),
`instanceGitApi: 1`. A read-only observation of one instance's work tree: the
branch the tree is on, not the recorded one (reported under `recorded`).

```text
oats instance git <instance> [--home <abs>] [--dir <d>] --json
oats instance diff <instance> --file <id> --revision <rev> [--index-revision <idx>] [--home <abs>] [--dir <d>] --json
```

`<instance>` is resolved under the deployment's agents root. Several homes of
that name: `E_AMBIGUOUS_INSTANCE {candidates: [{root, agent, home}]}` (pass
`--home`; a wrong one is `E_HOME_MISMATCH`). Unknown: `E_SESSION_UNKNOWN`. No
tree: `E_NO_WORKTREE`.

`E_NO_WORKTREE` is answered when nothing is at `<home>/work`, when it is not
inside a Git work tree, and (0.53.0, #962) when it is a real directory that
is not the top level Git names for it. Git answers for any directory inside
a work tree, so a plain `work/` in a home whose deployment directory is a
Git checkout was read as that checkout before: its branch and its files,
none of them the instance's. The rule is the path, in every work mode: a
`directory` instance in such a deployment has no work tree, and one whose
`work/` is the top level of a repository of its own is observed as before.
A `work/` that is a link is read as what it leads to, wherever that is: a
`workspace` instance's leads to the deployment directory, which is above its
home, and is observed as before. A [stop plan](#stop)'s and a
[retire plan](#retire)'s `work` read the same way, with the code as `reason`.

```json
{"instanceGitApi":1,"instance":"dev-1","agent":"dev","home":"/w/agents/dev/instances/dev-1","workMode":"worktree",
 "observation":{"revision":"46c20668…","indexRevision":"3147fef2…","at":"2026-09-26T18:15:26.487Z","worktree":"/w/agents/dev/instances/dev-1/work",
                "branch":"feat/y","detached":false,"unborn":false},
 "recorded":{"branch":"agents/dev-1","repo":"/w/one","drift":true},
 "upstream":{"ref":"origin/feat/y","ahead":1,"behind":0},
 "base":{"ref":"origin/main","source":"origin/HEAD","mergeBase":"46c20668…","ahead":2,"behind":0},
 "remote":{"name":"origin","url":"git@github.com:acme/one.git","host":"github.com","path":"acme/one","source":"branch-upstream"},
 "summary":{"changed":1,"renamed":1,"copied":0,"unmerged":0,"untracked":1},
 "files":[{"id":"0d0cd6557e40c03eba2abd46","kind":"renamed","xy":"R.","submodule":false,"score":"R100","path":"src/new.txt","origPath":"src/old.txt",
           "additions":84,"deletions":3,"binary":false}],
 "notes":[]}
```

- `observation.revision` is the HEAD oid (or `unborn`); `branch` is `null`
  when detached.
- `recorded` is what the spawn recorded in `instance.json`: `branch` (`null`
  when none was recorded) and `repo`. `drift` is `true` only when a branch
  was recorded and the tree is not on it. A home spawned before 0.49.0 may
  record the word `"HEAD"` for a detached attached or checkout tree; no
  branch has that name, so it reads as `branch: null` with `drift: false`.
- `upstream` without one is all `null` (unknown, not zero). `base` compares
  with the default branch's merge-base; `source` is `origin/HEAD` or
  `well-known`; none found is all `null` plus a note.
- `remote` (feature `instance-git-remote`): the branch's remote (`source:
  "branch-upstream"`), else `origin` (`"origin"`), else `null`; `host` and
  `path` are parsed from the URL (`host: null` for a local path). The kernel
  has no forge data.
- `files[]` come from porcelain v2: `kind` is `changed | renamed | copied |
  unmerged | untracked`; renames and copies carry `origPath` and `score`;
  ignored files are omitted. `summary` counts rows per kind.
- `files[].id` is opaque, minted under (`revision`, `indexRevision`); it is
  the only way to ask for a diff.
- `additions`, `deletions`, `binary`: line counts of the working tree against
  the observed commit. A binary file is `{null, null, true}`; an untracked
  file or submodule is all `null`; if counting fails every entry is `null`
  with a note. `null` means unknown.

The diff answers `{instanceGitApi: 1, observation, file: {id, kind, xy,
path, origPath}, against, binary, bytes, truncated, limit: 262144, patch,
readOnly: {helpers: "disabled", optionalLocks: "off", objectsWritten: 0}}`.

- `against` is the observed revision (the working tree against that commit,
  index included) or `"empty"` for an untracked file. A binary file has an
  empty patch; over 256 KiB, `truncated: true`.
- The read runs without external diff, textconv, fsmonitor, hooks, lazy
  fetch, the caller's Git environment or global config, and writes nothing
  (`readOnly`). An object a partial clone lacks is not fetched: the read
  fails with `E_GIT_FAILED` (with Git 2.44 or later; an older Git ignores
  `GIT_NO_LAZY_FETCH`).
- **Filter drivers are not run.** Git runs a `filter.<name>.clean` or
  `.process` command when a status or a diff compares a work-tree file that
  carries the `filter` attribute, and it has no switch that turns filters
  off. Before the Git commands that read a work-tree file, `oats instance
  git` and `oats instance diff` read the configuration Git would use (`git config --list`, which runs
  nothing and follows `include.path` and `includeIf`) and override every
  filter driver it defines to no command (`clean`, `smudge`, `process`) and
  not required. An observation makes that read once, before its status, for
  its status and its line counts; each command of a diff is preceded by its
  own.
  - A file such a filter applies to (a Git LFS file, for one) is compared as
    its bytes are in the work tree, not as the filter would store them. An
    untouched file still reads as unchanged, by its recorded size and times.
    One that was rewritten, or whose times Git cannot tell from the index's,
    reads as `changed` even when its filtered form is what is stored; its
    line counts and its diff are the stored form (an LFS pointer) against the
    work tree's bytes. The observation then carries a note that the
    repository's configuration defines a filter driver.
  - A driver whose name cannot be passed on Git's command line (it holds `=`
    or is not UTF-8) cannot be overridden: Git is not run, and the read fails
    with `E_GIT_FAILED`.
  - Not covered: a driver written into the configuration between that read
    and a Git command it covers (for an observation, up to its line counts,
    which follow its status and its reads of HEAD, the index and the refs),
    and a filter a **submodule's own**
    configuration defines. Git runs inside each populated submodule to learn
    whether it is dirty, and the overrides name the repository's drivers, not
    the submodule's. A dirty submodule stays visible in the status for that
    reason. Where the agent and the reader of its worktree are one system
    user, which is the usual arrangement, such a filter runs nothing the agent
    could not run itself. Where they are separate users, it runs the agent's
    command as the reader's user: do not read a worktree with populated
    submodules across users.
- If HEAD or the index moved, the id is not in the current observation, or
  anything moved during the read: `E_STALE_OBSERVATION` with
  `details.observation`. Re-observe; never render a diff of another tree.
- A `--file` that is not 24 hex, or no `--revision`: `E_BAD_ARGS`. Git
  failure: `E_GIT_FAILED`.

## Events

Feature `instance-events-2`, `eventsApi: 2`: typed lifecycle events, written
by the kernel action that made them true.

```text
oats instance events <instance> [--limit <n>] [--since <iso>] [--home <abs>] [--dir <d>] --json
```

```json
{"eventsApi":2,"instance":"dev-1","home":"/w/agents/dev/instances/dev-1","incarnation":"2026-09-28T10:08:01.281Z",
 "count":1,"returned":1,"truncated":false,
 "integrity":{"unreadableRows":0,"foreignRows":0,"sources":[{"path":"home","status":"ok","bytes":612},{"path":"workspace","status":"ok","bytes":612}]},
 "events":[{"eventsApi":2,"at":"2026-09-28T10:08:02.000Z","instance":"dev-1","home":"/w/agents/dev/instances/dev-1","incarnation":"2026-09-28T10:08:01.281Z",
            "producer":"kernel","kind":"spawned",
            "data":{"agent":"dev","work":"worktree","branch":"agents/dev-1","harness":"claude","model":null,"parentInstance":null,"relation":null,"launched":true}}],
 "lastEvent":{"kind":"spawned","at":"2026-09-28T10:08:02.000Z","producer":"kernel","incarnation":"2026-09-28T10:08:01.281Z"},
 "waitingOnYou":null,"waitingClaims":[],"notes":["…"]}
```

- **Sources.** `home` is `<home>/.oats-events.jsonl`; `workspace` is
  `<deployment>/.agents/events/<agent>--<instance>.jsonl` (it survives the
  home). The deployment is the one the home's spawn recorded, when that
  directory really holds the home at `agents/<agent>/instances/<instance>`;
  otherwise it is the fourth ancestor of the home as it was addressed. Each is `{path, status: "ok" | "absent" | "refused" | "tail",
  bytes}`. Only a regular file is opened (no symlinks, same device and inode
  after open), and at most its last 4 MiB is read (`"tail"`).
- **Kinds:** `spawned`, `launched`, `restarted`, `stopped`, `stop-refused`,
  `modules-upgraded` (`data: {receipt, modules:[{capability, from, to}]}`,
  written after the module swap and retirement baseline complete),
  `upgrade-refused` (a failure with no successful or uncertain apply-hook outcome,
  naming the failed step or module; older clients tolerate the unknown kind),
  `retire-planned`, `retired`, `retire-refused` (0.53.0,
  [below](#retire-refused-event)), `worktree-retained`, `worktree-removed`,
  `branch-deleted` (not written since 0.41.0: no retire deletes a branch;
  older logs hold it), `child-spawn-refused`, `launch-warning` (0.30: a
  `launch` hook's warning at session start/restart, `data: {message}`),
  `retire-warning` (a retire hook's warning, `data: {message}`: one row per
  entry of the retire hooks' `warnings`, a hook's own `warning` and the
  kernel's lines about those hooks alike, in their order; written to the
  workspace log only, as soon as the hooks return, so a retire that then
  refuses or ends quarantined keeps them, and each run of the hooks, a retry
  among them, adds its own; older clients read it as an unknown kind),
  `recomposed` (from earlier kernels), `waiting` (0.40: a producer's claim,
  [Waiting on you](#waiting-on-you)), `wake-held` (feature `wake-hold`: a
  scheduled wake began to hold, one row per hold, `data: {schedule, since,
  claimReason, producer, unreadable?}` as in [A held
  wake](schedules.md#a-held-wake); it carries no `waitingOnYou` and is never a
  claim, and a retiring home's row goes to the workspace log only),
  `worktree-added` (0.49.0, feature
  `worktree-event`: `oats worktree add` made an extra tree, `data: {purpose,
  path, branch, base, baseOid, remote, member, hooks}`, `remote` without
  credentials, `member` a key or `null`, `hooks` the `worktree` hooks'
  receipt). `producer` is `kernel`, a capability id,
  or another producer id (`agent`). Older rows may carry `eventsApi: 1`.
  The `message` of a `launch-warning` or `retire-warning` row is the
  warning's text as stored: control, bidi and hidden characters replaced
  with U+FFFD, cut to 2048 UTF-16 code units ending in `…` (never through a
  surrogate pair); a warning that is not a string is stored as its JSON.
  Clients show it as plain text. The answer that carried the warning
  (`warnings`) keeps it as it was said.
  `launched` is written by spawn and, since 0.40, once per session start or
  restart, as soon as the session exists (`data: {harness, backend,
  launchConfig, phase, startId}`; spawn's row has neither `phase` nor
  `startId`). `phase` is `start` or `restart`, or `recovered` when a later
  start adopted an interrupted start's receipt that had no boundary; that row
  is dated at the receipt's launch time. The boundary is complete per log: a
  log that missed it gets a copy of the same row (same time and data), never
  a second one.
- `spawned` carries `worktreeHooks` (the receipt `[{capability, ok,
  required, log, exitCode, …}]`) in its `data` only when the spawn ran
  `worktree` hooks (0.49.0).
- `retired` (`data: {agent, keepDir, self, quarantine, workRecovery, hooks,
  reason?}`) is written to the workspace log only,
  `<deployment>/.agents/events/<agent>--<instance>.jsonl`, which outlives the
  home. What its hooks warned is not in it: those are the `retire-warning`
  rows written before it. `reason` is present only when
  the retire completed a self-retire an older OATS recorded with
  `--delete-branch` (since 0.41.0: `this self-retire was requested with
  --delete-branch by an older OATS; retirement no longer deletes branches, so
  the branch and the worktree were left`).
- <a id="retire-refused-event"></a>`retire-refused` (0.53.0; `data: {code,
  homeChanged, reason}`) is written once by the completion of a scheduled
  self-retire (`oats retire <instance> --self`) that did not complete, and
  by nothing else. A retire that a person runs answers that person and
  writes none. No feature names the kind: a client that does not know it
  reads the row as it reads any unknown kind.
  - `code` is a kernel code, or `null`. It is the code the retire answered.
    It is `null` for the one outcome that is a result and not an error: a
    cleanup that did not finish, with the home retained in quarantine.
    `null` means that outcome, never "unknown".
  - `homeChanged` is `false` when no retire hook was started and nothing of
    the home was removed, and `true` otherwise. It is always `true` for the
    incomplete cleanup. A session or a child that was stopped on the way
    does not count.
  - `reason` is the sentence the retire answered, on one line and at most
    2048 UTF-16 code units. A longer sentence is cut and ends with `…`,
    which is counted in the 2048. The bound is the Desktop events reader's,
    which refuses a whole read that holds a longer detail. For the
    incomplete cleanup it is a sentence of the kernel's own that names no
    item; the items are in the completion's result file.
  - The row is in the workspace's log only, and carries the incarnation
    the home had before the retire ran. The completion holds no claim when
    it writes, so it writes nothing into a home.
  - With `homeChanged: false` the self-retire's pending marker is gone as
    well, and with `true` it stays
    ([a completion that does not complete](souls-and-instances.md#self-retire-not-completed)).
- `stop-refused` and `retire-refused` each cover two cases: a verb that was
  refused, and one that failed after it began.
- `worktree-retained` (`data: {movedTo, branch, recordedBranch}`) and
  `worktree-removed` (`data: {branch}`) are written to the workspace log only,
  by the retire's worktree step. Since 0.42.1 the retire also writes one per
  extra tree it handled
  ([extra trees at retire](souls-and-instances.md#extra-trees-at-retire)),
  with `extra: true` and the tree's absolute `path` added:
  `worktree-retained` `{movedTo, branch, recordedBranch: null, extra: true,
  path}` and `worktree-removed` `{branch, extra: true, path}`. A row without
  `extra` is about `work/`.
- **Incarnation.** Each row carries the writing home's `createdAt` (or
  `null` for old rows); the top-level `incarnation` is the current home's (or
  `null`). Earlier incarnations are returned as this address's history.
- **Address.** `--home` must be a home of `<instance>` (`E_HOME_MISMATCH`),
  or a retired one (below). A home has one address in storage, its real path (since 0.40.2): rows are
  written and matched under it, whatever spelling a writer or reader used (a
  deployment reached through a symlink, a symlinked agents root). The answer
  keeps the spelling it was asked in: the top-level `home` and every
  returned row's `home` are the home as the caller addressed it (`--home`,
  or the home found under `--dir`), the same string a status row carries.
  Rows for another address are dropped and counted in
  `integrity.foreignRows`; torn or invalid lines are counted in
  `integrity.unreadableRows`. A row present in both logs is returned once;
  identical rows repeated within one log (a set, a clear and the same set in
  one millisecond) are all returned, as many as the log holding the most
  copies has.
- **Rows from before 0.40.2**, in a deployment addressed through a symlink
  only. A stored `home` is never rewritten, and never matched under another
  spelling. A row an earlier kernel wrote under the lexical spelling (a
  spawn's rows, and the claims of a session that was spawned and never
  restarted) is foreign after the upgrade, and counted in
  `integrity.foreignRows`. What that means for a claim:
  - A claim that was live under the lexical spelling stops showing. Nothing
    brings that row back: the claim shows again only when a producer makes it
    anew (the next permission prompt or question, the agent's next
    `oats instance attention`). A restart starts a new session with no
    claim, as always.
  - A claim that stayed set because the restart that should have voided it
    was recorded under the real path (#583) is gone.
  - The rows a started or restarted session wrote under the real path, which
    `oats status --dir <symlink>` could not see, are read now. They cannot
    surface a stale claim: such a session wrote its clears and its session
    boundaries under the real path too, so that history is complete.
- **A retired instance** (#642) answers from its workspace log, which
  outlives the home. This applies only when no live home resolves: a live
  home of `<instance>` under the scope is always answered as above. Without
  `--home`, the kernel lists `<deployment>/.agents/events/*--<instance>.jsonl`
  (the deployment is the directory holding the scope's agents root) and takes
  the agent from the file name. One log answers for
  `<agents root>/<agent>/instances/<instance>`. Several (one name retired
  under two agents) refuse with `E_AMBIGUOUS_INSTANCE`, the message naming
  the count and asking for `--home`, and `details.candidates[]` listing each
  as `{root, agent, home}`. No log is `E_SESSION_UNKNOWN`, as before. A
  `--home` naming a removed home answers only when it is
  `<agents root>/<agent>/instances/<instance>` (compared by real path, so a
  symlinked spelling of the root is the same address) and
  `<deployment>/.agents/events/<agent>--<instance>.jsonl` exists; the agent
  is taken from the path. The logs are read from the scope's spelling of the
  home, and the answer's `home` (and each row's) is the `--home` as given.
  Any other removed `--home` is `E_HOME_MISMATCH`.
  The answer has the same shape as a live home's: the `home` source is
  `absent`, and `incarnation` is `null` (no `instance.json` remains), so
  `waitingOnYou` is `null` and `waitingClaims` is empty. The rows keep the
  incarnation they were written with.
- **Window.** `count` is the rows after `--since`; `returned` the window
  (`--limit`, default 200, 1–2000); `truncated` means rows were cut or a
  source was a tail. `lastEvent` is `{kind, at, producer, incarnation}` of
  the last returned row, or `null`.
- **Waiting.** `waitingClaims[]` is `{producer, waiting, since, reason,
  message}` per producer with a live claim in the current incarnation
  (cleared ones included). A producer's latest row with `data.waitingOnYou`
  decides. `waitingOnYou` is `{since, producer, reason, message}` of the
  newest positive claim that has a message, so a claim with no text never
  hides one with text; when its `reason` is `null`, the newest text-less
  claim's reason fills it. With no message anywhere it is the newest
  positive claim, or `null` (unknown, not "not waiting"). See
  [Waiting on you](#waiting-on-you) for the producers and the rules.
- Errors: `E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`,
  `E_BAD_ARGS`, `E_EVENTS_FAILED`.

### Waiting on you

Feature `waiting-on-you` (OATS 0.40.0): an instance waiting on a human (a
permission prompt, a question, an agent asking for an answer) says so through
a producer's claim. **A claim authorizes nothing; it may only withhold an
automated keystroke.** A scheduled wake holds while the home has a live
`permission`, `question` or unknown-reason claim ([A held
wake](schedules.md#a-held-wake), feature `wake-hold`), and nothing else in the
kernel acts on a claim. In particular `oats session input` behaves exactly as
before whether or not a claim is set. `attention` never marks a screen an Enter
answers: a producer that wants one uses `question`, and review catches that.

```text
oats instance waiting <set|clear> --producer <id> [--reason permission|question|attention] [--message=<text>] [--home <abs>] [--dir <d>] --json
oats instance attention [--message=<text>] [--clear] --json
```

```json
{"eventsApi":2,"instance":"dev-1","home":"/w/agents/dev/instances/dev-1","producer":"oats.core","changed":true,
 "waitingOnYou":{"since":"2026-10-03T12:00:00.000Z","producer":"oats.core","reason":"permission","message":null}}
```

- **The row.** A claim is a `waiting` event, `data: {waitingOnYou: true,
  reason, message?}` or `{waitingOnYou: false}`, appended to both logs, with
  `producer` the caller's `--producer`.
- **`waiting`.** `--producer` matches `^[a-z0-9][a-z0-9._/-]{0,63}$` and is
  not `kernel`. `set` needs `--reason`, one of `permission`, `question`,
  `attention` (closed). `clear` refuses `--reason` and `--message`. The home
  is `--home`, else `$OATS_INSTANCE_HOME`, else the instance home enclosing
  the working directory; it must be a home of its own name under the scope
  (`--dir`, else the agents root the home sits in).
- **`attention`** is the agent's own claim, run by the instance from its
  home: sugar for `waiting set --producer agent --reason attention
  [--message]`, and `--clear` for `waiting clear --producer agent`. Its home
  comes only from `$OATS_INSTANCE_HOME`: it has no `--home` or `--dir` and
  never targets another instance. Unset, or not an instance home (no readable
  `instance.json`), is `E_USAGE`. `--clear` with `--message` is `E_BAD_ARGS`.
- **`--message`**: one line of 1 to 200 characters (code points). Refused,
  as `E_BAD_ARGS` naming `--message`: control characters (`\p{Cc}`: C0, DEL,
  C1; so no newline, tab or ESC), the line and paragraph separators U+2028
  and U+2029, the bidi embeddings, overrides and isolates U+202A–202E and
  U+2066–2069, the invisible U+200B (zero width space), U+2060 (word
  joiner) and U+FEFF (BOM), and the tag characters U+E0000–E007F. Everything
  else is allowed, including ZWJ and ZWNJ (U+200C, U+200D: emoji sequences
  such as 👩‍💻, Persian and Indic text), the marks LRM, RLM and ALM (U+200E,
  U+200F, U+061C) and the soft hyphen. A message that
  starts with `--` goes inline, `--message=--deploy failed`: that value is
  only ever the message, never a flag (`--message=--clear` sets the message
  "--clear"). The spaced form `--message --deploy` reads `--deploy` as a
  flag and is `E_BAD_ARGS`. It is stored as given, only on a
  positive claim. The reader applies the same rule again, with one
  difference: a stored message over 200 code points (a row from another
  producer or an older writer, or a remote kernel's claim) is cut to 200, the
  last one `…`. So `waitingOnYou.message` and each `waitingClaims[].message`
  are never longer than 200 code points, whoever wrote them. The cut counts
  code points: a surrogate pair is never split, but a combining mark may be
  left out. A message that is still invalid after that (a refused character,
  a hand-edited log) reads as `null`, and the claim still counts.
  A stored `reason` outside `permission`, `question`, `attention` reads as
  `null` too, and a row whose `producer` is neither `kernel` nor a valid
  producer id, or whose `at` is not a date, is no claim at all.
- **Idempotent.** The verb reads the producer's live claim first and appends
  only on a change: a `set` whose reason or message differs from the live
  positive claim appends (`changed: true`), an identical one does not; a
  `clear` appends only over a live positive claim. The answer is
  `{eventsApi, instance, home, producer, changed, waitingOnYou}`, where
  `waitingOnYou` is that producer's resulting claim (`null` when it holds
  none) and `home` is the home as the caller addressed it (`--home`,
  `$OATS_INSTANCE_HOME` or the enclosing home); the row is stored under the
  real path, so a set and a clear through different spellings of one home
  meet. Concurrent writers append whole lines; the latest row decides.
  Each log is judged on its own, and success means both took the row: a
  write either log refused is `E_EVENTS_FAILED` naming it, and the next call
  (a retry) appends again to repair it.
- **Session boundary.** A claim written before the incarnation's latest
  kernel `launched`, `restarted` or `stopped` row (in time order; rows of the
  same millisecond in append order) is not live: it belongs to an ended
  session and is not listed in `waitingClaims`. A crash
  while waiting reads `null` on the roster (not running), and the next start
  writes `launched`, which voids the claim.
- **Producers.**
  - `oats.core`: the Claude Code emitter oats.core installs in a Claude
    instance's `<home>/.claude/settings.json` (`permission` on a permission
    prompt, `question` on AskUserQuestion or an MCP elicitation, `attention`
    on a turn an API error ended, or `question` for an error class that can
    open a menu, cleared when the session moves on). See
    [capabilities.md](capabilities.md), "oats.core: needs input".
  - `oats.pi`: the `@awebai/oats-pi` bridge (`attention` on a turn a provider
    error ended, once pi has stopped retrying, cleared by the next run). See
    the same section, "A failed turn".
  - `agent`: the instance itself, through `oats instance attention`, and
    only through it: `oats instance waiting --producer agent` is
    `E_BAD_ARGS`. **Agent claims are cleared only by the agent (`--clear`)
    or a session boundary**; no hook clears them (a wake broker's paste is
    also a prompt submit).
- **Where it shows.** `waitingOnYou` on the events read, on `oats status
  --json` instance rows (running rows only) and on `oats session inspect
  --json` (beside `state`, whose enum is unchanged; `null` unless the harness
  is running). Plain `oats status` prints `! needs input (<reason>) since
  <start>, <elapsed>: <message>` under a running instance's row while it holds
  a claim (the message and its colon are omitted when absent). The start is
  local to the CLI machine: `HH:MM` today, `Mon D HH:MM` on another day in
  the same year, or `YYYY-MM-DD HH:MM` in another year. Elapsed time is floored
  to `under a minute`, `N min`, `N h` or `N d`. A future start omits elapsed
  time; an unparseable start retains the line without any time.
- **Cost.** To compute the field, `oats status` reads the home log of each
  running row (the workspace log only when the home log is absent), with
  the same bounded read as the events read: at most the last 4 MiB, so a
  claim older than the last 4 MiB of a very busy log is not seen. Stopped
  rows read nothing.
- **Local only.** Neither verb routes with `--server`: producers run on the
  instance's own host.
- Errors: `E_BAD_ARGS`, `E_USAGE` (attention), `E_SESSION_UNKNOWN` (no
  readable `instance.json`), `E_HOME_MISMATCH`, `E_EVENTS_FAILED` (the write
  failed; nothing else is affected).

## Upgrading an instance's package modules

Requires the `instance-upgrade` feature in `oats version --json` or `oats status --json`.

```text
oats instance upgrade <instance> --plan [--json]
oats instance upgrade <instance> --plan-revision <revision> --idempotency-key <key> [--json]
oats instance upgrade <instance> --undo --plan [--json]
oats instance upgrade <instance> --undo --plan-revision <revision> --idempotency-key <key> [--json]
```

This local act resolves an instance like `oats retire`, from its deployment
or a parent's home. It uses the lifecycle claim and requires a stopped,
readable session. A running or unreadable session is `E_SESSION_RUNNING`,
naming `oats instance stop <instance>`, upgrade, then session start. It does
not support `--server` or several homes in one call.

A read-only plan stages package copies outside the home, verifies the locked
commit and integrity as spawn does, then removes that staging. Its revision
hashes the facts. Each moving module reports `{capability,
from:{version,commit,digest}, to:{version,commit,integrity},
skills:{added,removed,changed}, inject, hooks, provider:{decision,reason}}`.
`inject` and `hooks` indicate changes. The plan also lists kept modules and
member drift and `homeChangedSinceSpawn` (both excluded from `planRevision`).
A package no longer in the lock is kept. Member modules and
the soul body never move. A provider refusal refuses the whole act.

Apply rechecks the revision under the lifecycle claim (`E_PLAN_STALE` with
a fresh plan on mismatch) and records an idempotency receipt. It stages the
whole modules, skills, inject and hook composition through spawn's composer,
using the soul at its recorded commit. It saves and verifies the previous
state before provider hooks run, swaps the composition, updates only a clean
home's retirement `homeFingerprint`, commits the receipt, then appends
`modules-upgraded`. A dirty home keeps its baseline file byte-identical, so
older kernels also preserve its pre-upgrade edits at retirement. Work-tree
fingerprints and digest versions always remain as recorded. The moved module record's `previous`
is described under [`instance.json`](#instancejson).
Upgrade runs no launch hooks. When a moved module's new manifest has no launch
hook, apply removes its recorded launch/environment contribution in the same
journaled metadata swap. When it still declares a launch hook, the existing
contribution stays with settings and trust refreshed, until the next start
replaces it wholesale. Undo restores the recorded contribution from the
backed-up `instance.json`. There is no pending dropped-hook state to resolve
at start, so consecutive upgrades need no intervening start.
Receipts live at `<home>/.oats/upgrade-receipt.<key>.json`. Retirement's baseline
excludes only that exact receipt filename pattern and `.oats/.staging-upgrade-*`;
`.oats/previous/` is ordinary home content covered by the baseline.

Before the commit boundary, failure restores composed home bytes and removes
staging and the saved previous state only when no provider hook succeeded or
has an uncertain outcome. A non-zero hook result must be explicitly observed
and recorded in the same invocation to permit this rollback. A hook reporting
failure must leave no effects of its own; provider host effects are its
responsibility.

Before spawning a hook, the receipt records `step: "hook <capability>"` and
`hooks.inFlight: <capability>`. Resuming an unknown in-flight outcome durably
records `uncertain: [<capability>]` before retry work. Even a kill before spawn
counts as uncertain if not-started cannot be proved. After any success or
uncertainty, failure records `partial`: the error names pending work and asks
for the same `--idempotency-key` to finish forward. Retry re-runs pending
idempotent hooks, including an uncertain one. A subsequent hook failure stays
partial; it cannot authorize rollback. Start refuses with `E_UPGRADE_PARTIAL`
while the receipt is partial. If completion is impossible, the remedy is respawn.

The commit boundary is after swap and baseline: the receipt becomes
`status: "complete"` with `steps.cleaned: false` before the success event and staging cleanup.
Successful cleanup sets `steps.cleaned: true`. A failure after that boundary
leaves the upgrade committed. The same-key retry finishes event publication
and cleanup, without
hooks or copies. Start is allowed with one warning naming that retry; a new
upgrade or undo plan refuses until cleanup finishes. `E_UPGRADE_PARTIAL`
applies only before commit. Retirement adds no special cleanup behavior.

`--undo` uses the latest verified previous state and the restored version's
`upgrade` hook, under the same adoption and failure protocol. A version
without that hook cannot be restored through this act; respawn instead.

## Lifecycle: stop and retire

Feature `lifecycle-plans` (and `retire-retention`), `lifecycleApi: 1`. A
**plan** lists what an action would touch, with a `planRevision` (24 hex)
hashed from the facts that make it safe. Apply carries the revision back; if
reality moved it refuses `E_PLAN_STALE` with the fresh `details.plan`. An
idempotency key (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`) makes a retried apply
return the first receipt. Recorded parentage (`parentInstance`) is the only
relation followed; a child whose parent name matches several homes is listed
under `ambiguous` and never acted on. Parentage is read from each home's
`instance.json`: a home whose record cannot be read is never stopped as
anyone's child. It is in no plan's `targets`, `children` or `ambiguous`, and
no stop or retire of its parent names it, so its session may go on running
under a parent that was stopped or retired. `oats status` is where it shows
([its row](#unreadable-record-row)).

<a id="unreadable-record"></a>
**A home whose `instance.json` is there and cannot be read** as a JSON object
(cut off, empty, kept from the user, a directory, a link to nothing, JSON
that is not an object; OATS 0.52.0) decides only for itself.

- Every command about another instance answers as if that home were not
  there: its stop and retire plans and applies, `oats session`, `oats
  instance events`, a spawn, the roster.
- Every lifecycle command about that home is refused with
  `E_UNIDENTIFIED_INSTANCE_HOME` before it takes a claim, reads the home or
  touches anything: `oats retire` (plain, `--plan`, guarded, `--self`), `oats
  instance stop --plan` and `--apply`, `oats session start` and `restart`.
  The answer has no `details`, and the message is `<home>/instance.json
  cannot be read (<reason>); nothing was done. Restoring the file from a copy
  makes the home usable again; removing such a home through OATS is not
  possible yet.`
- `oats retire --force` is refused the same way. `--force` removes a home
  that has no `instance.json`; a home whose record is there and cannot be
  read may be a whole instance with work, and is never removed blind.
- The lineage is read from records. A parent whose record cannot be read has
  no recorded children for a stop or a retire: they are listed, and each is
  stopped and retired on its own. A home whose record cannot be read is never
  stopped as anyone's child: it is not a target of its parent's stop or
  retire, no plan and no answer of either names it, and a retire does not
  repair its lineage. Its session may go on running under a parent that was
  retired; `oats status` is where it shows.
- A spawn that names such a home as its parent or anchor is refused
  (`E_UNIDENTIFIED_INSTANCE_HOME`, the same sentence with `nothing was
  spawned`; `E_SPAWN_FAILED` before 0.56.0): the parent's child-spawn policy
  and the lineage are in that record.
- `oats session inspect`, `input` and `attach` on that home answer
  `E_RUNTIME_ENDPOINT_UNKNOWN`, and `oats instance events` still reads its
  logs.

`E_UNIDENTIFIED_INSTANCE_HOME` for a record that cannot be read is answered
only before any effect: nothing was signalled, run, copied or removed. A
record that becomes unreadable after a retire has taken the home's claim is
refused with the same sentence, before the retire's first signal (the end of
the hook group an interrupted spawn left); in a guarded apply, with
[its plan's `retire-planned` event](#guarded-apply-plan-event) already
appended to the workspace log. That answer alone carries
[`details.reached`](#retire-reached), untouched: `{phase: "before-effects",
sessionStopAttempted: false, hooksStarted: false, home: "kept", recovery:
null}`. A plan refuses the same way when the record became unreadable after
the home was resolved.

### Stop

```text
oats instance stop <instance> --plan [--no-recursive] [--home <abs>] [--dir <d>] --json
```

```json
{"lifecycleApi":1,"action":"stop","instance":"dev-1","home":"/w/agents/dev/instances/dev-1","recursive":true,"at":"2026-09-28T11:00:00.000Z",
 "targets":[{"instance":"dev-1","agent":"dev","home":"/w/agents/dev/instances/dev-1","depth":0,"workMode":"worktree","launched":true,
             "session":{"state":"unknown","present":true,"backend":"tmux","established":true},
             "work":{"observed":true,"revision":"46c20668…","branch":"feat/x","detached":false,"drift":false,"changed":2,"untracked":1,
                     "upstream":{"ref":null,"ahead":null,"behind":null},"base":{"ref":"origin/main","ahead":1,"behind":0},"remote":{"host":"github.com","path":"acme/one"}},
             "retiring":false,"stopPending":false,"midTask":true}],
 "skipped":[],"ambiguous":[],"planRevision":"9c1f2e3d4b5a69788796a5b4","notes":[]}
```

- `targets`: the recorded descendants, deepest first, then the instance
  (`depth: 0`). With `--no-recursive` descendants go to `skipped` (`{instance,
  agent, home, reason: "recursive=false"}`). `ambiguous[]`: `{instance, agent,
  home, reason}`.
- `session.state` is the backend's word: `shell`, `stopped` and
  `not-launched` are idle; `unknown` is a running process tmux cannot name
  (the normal state of a harness). Not established: `{state:
  "unestablished", present: null, backend: null, established: false,
  reason}`; render it as unknown, never idle. `reason` is the kernel code of
  what failed (`E_SESSION_UNAVAILABLE` for an error that has none).
- `work` is the Git observation summarized (`changed` counts changed,
  renamed, copied and unmerged rows), or `{observed: false, reason}`:
  `"no-worktree"` when nothing is at `work/`, or the kernel code of what
  failed (`E_NO_WORKTREE` for a `work/` that is no work tree of the
  instance's, as [`oats instance git`](#git-and-diff) answers it;
  `E_GIT_FAILED` for an error that has none; `E_WORK_INSPECTION_FAILED` for
  a home the kernel cannot look into, where whether it has a `work/` cannot
  be told; OATS 0.52.0).
- `midTask`: `true`, `false` or `"unknown"`.
- `retiring` and `stopPending`, booleans on every target, say who holds the
  target's home when the plan is read (OATS 0.52.0, feature
  `lifecycle-claim-stop`). `retiring`: a self-retire is scheduled for it
  (its pending marker is there), or a retire holds its
  [claim](#retire-one-at-a-time). From 0.53.0 the marker outlasts a
  completion that did not complete only when a retire hook was started or
  the removal of the home began
  ([a completion that does not complete](souls-and-instances.md#self-retire-not-completed)).
  `stopPending`: a stop apply holds its
  claim. A holder counts while it is not known to be gone: alive, or of a
  liveness that cannot be read. `retiring` is one of the facts
  `planRevision` is hashed from, as it was; `stopPending` is not. The
  plan's `notes` say in a line that an apply will refuse either: a note is
  a sentence for a person, and no client keys on its text (`retiring` and
  `stopPending` are the data). Before
  0.52.0 `retiring` read the pending marker alone and `stopPending` read a
  file inside the home ([below](#stop-claim)).

```text
oats instance stop <instance> --apply --plan-revision <rev> --idempotency-key <key> [--no-recursive] [--grace-ms <n>] [--home <abs>] --json
```

Children first: SIGTERM to the harness processes and a bounded wait
(`--grace-ms`, 1–300000, default 20000), never escalated. Home, work,
transcript and launch configuration are kept; `oats session restart` brings
the instance back.

<a id="stop-claim"></a>
**A stop holds the claim of every target** (OATS 0.52.0, feature
`lifecycle-claim-stop`; #866, #890). It is the file that orders the retires
of a home ([One retire of a home at a time](#retire-one-at-a-time)):
`<instances>/.oats-retirement/claims/<instance>.lock`, beside the homes, its
record naming the holder by pid and start time and by its verb (`action:
"stop"`). With `--server` it is taken on the host. An apply does this, in
this order:

1. It refuses bad arguments (`E_BAD_ARGS`), `--grace-ms` among them.
2. It reads the plan, for its targets.
3. It replays a receipt stored under the same key (below). No claim is
   taken for that.
4. It takes the claim of every target, in one fixed order (by the claim's
   path), so that two overlapping stops never each hold half: one takes the
   first file both want, and the other is refused at once and releases what
   it took. **A holder is answered here, before a stale plan**, as a guarded
   retire answers it: `E_INSTANCE_RETIRING` beside a retire,
   `E_LIFECYCLE_BUSY` beside another stop
   ([Commands that meet on one home](#lifecycle-pairs)). A stop never waits
   for a holder. A claim that cannot be written is
   [read in its place](#stop-claim-write) (OATS 0.53.0): whoever holds it
   is answered the same way, here.
5. It reads the plan again, under the claims: this is the plan it acts on.
   **It holds the claim of every target of this plan before it does
   anything.** A target it does not hold yet (a child recorded, or readable
   again, since step 2) sends it back to step 4 with this plan's targets,
   every claim released first so that the order of step 4 holds. A target
   whose claim was only read counts as held for this, and its claim is
   read once more now, before the comparison below: a holder that came
   since is answered as in step 4. A stop
   whose targets are others under each of three such reads (a constant of
   the kernel: there is no setting for it) gives up:
   `E_LIFECYCLE_BUSY`, `holder: "none"`, `… nothing was stopped — run the
   command again`. It then compares the plan's revision with the one sent,
   once: `E_PLAN_STALE` with the fresh `details.plan` (the claims this
   apply holds are not reported in it as `stopPending`). A home that was
   retired since the plan was shown answers `E_SESSION_UNKNOWN`; one whose
   `instance.json` can no longer be read, `E_UNIDENTIFIED_INSTANCE_HOME`; a
   child in that state is no longer a target, which is a changed plan.
6. It refuses a target for which a self-retire is scheduled
   (`E_INSTANCE_RETIRING`, with `details.plan`).
7. It stops each target, writes the receipt and releases the claims.

Everything through step 6 is before any effect: nothing was signalled, and
nothing was written into a home. From step 7 on a target's failure is a row
of the receipt, and no answer of the apply carries a code of
[the list](#before-effect-codes). A target that was never launched, or is
idle, is claimed and released like any other; its row says `alreadyIdle`.

A stop that is killed (SIGKILL, SIGTERM, SIGINT or SIGHUP) leaves its claim
files, and they refuse nothing: the next stop or retire of that home takes
over the claim of a holder that is gone. Before 0.52.0 a stop marked each
target with `<home>/.oats-stop-pending.json`, a file that named no holder,
so a killed stop left every later stop of that instance refused
(`E_LIFECYCLE_BUSY`) until someone removed the file (#890).
**`.oats-stop-pending.json` stays a reserved name.** This kernel neither
writes nor reads it. One that an older kernel left refuses nothing, does not
make `stopPending` true, and is removed by the next stop apply of that home
once it holds the claim; a removal that fails is a warning on stderr (`oats:
warning: …`, in both modes) and the stop goes on.

<a id="stop-claim-write"></a>
**A stop whose claim cannot be written reads it instead** (OATS 0.53.0;
#946). Stop is what a person reaches for when a disk is full, and a stop
that leaves a session running because it could not write a file protects
nobody. So `oats instance stop --apply`, and it alone, reads a claim it
cannot write, for a reason that stops every other writer of this user as
well, and goes on when nobody holds it. It holds nothing for that target,
and says so on stderr. A retire, a start and a restart, and a retire's stop
of a recorded child, need their claim.

The reasons are five codes of the system's, met at one of the claim's
writes (its directory, its file, and the same two of a takeover's own
claim):

| The system's code | It means |
|---|---|
| `ENOSPC` | the file system is full |
| `EDQUOT` | this user's quota is spent |
| `EROFS` | the file system is read-only |
| `EACCES`, `EPERM` | the claims directory is not writable by this user |

Each is in the list for one reason: what stops this stop from writing a
claim in that directory stops a retire or another stop of the same user as
well, so a claim that reads as held by nobody is held by nobody. `EACCES`
and `EPERM` are there because every instance of a deployment can change the
claims directory, and one that takes write permission from it must not take
Stop from the operator. On a shared deployment that is the likely case of a
warning below, and its cure is to fix the directory's permissions, not to
live with the warning. Any other code (`EIO`, `EMFILE`, `EEXIST` from a
file where the directory belongs) says nothing about who else could write
there, and is refused as in 0.52.0: `E_LIFECYCLE_FAILED`, `the claim <lock>
could not be taken (<the system's error>); nothing was done`, with the
system's code in [`details.cause`](#kernel-codes) and the plan it read in
`details.plan`; nothing was signalled.

**What the read answers** is what the taking would have answered for what
is at the claim's path, with one difference:

- **Nobody holds it** (no file there; or a holder that is verifiably gone,
  whose claim a command that can write would take over): the stop goes on.
  This is the difference: the dead holder's file is left as it is, for the
  next command that can write to take over.
- **A holder that is alive, or whose liveness cannot be read, and a file
  that is no readable claim:** the cell of
  [the pair table](#lifecycle-pairs) for an arriving stop, with the same
  sentence and the same `details`. Nothing was signalled.
- **A file of a gone holder that no kernel can take over** (no `nonce` of a
  claim's shape): `E_LIFECYCLE_BUSY`, `holder: "none"`, as for a stop that
  can write. Its message says to inspect the file and remove it. On a full
  disk that removal works; in a directory that is not writable the person
  has to make it writable first.
- **The claim cannot be read either** (its path cannot be reached): the
  `E_LIFECYCLE_FAILED` of the write, as above. The read is positive or it
  is nothing.

The read is made twice: where the claim would have been taken (step 4), and
again once the plan has been read under the claims (step 5), before the
revision is compared. A holder that came in between is answered there,
before a stale plan and before any signal, with the fresh plan in
`details.plan`.

**What it gives up.** Nothing on the home shows this stop: a plan read
meanwhile says `stopPending: false`, and a retire or a stop that starts
while it runs, and that can write its claim, is not refused. That is space
freed a moment later, or a process of another user, for whom the directory
is writable. The two commands then work in one home at once, as every stop
did before 0.52.0. The warning says it, one line per such target, on stderr
in text and in JSON mode:

```text
oats: warning: <instance>: stopping without its claim: <lock> could not be written (<CODE>), and nobody holds it. A retire or a stop of <instance> that starts while this one runs will not see it.
```

`<lock>` is the claim's own path and `<CODE>` the system's code, never its
message. It is printed only when the apply answers a receipt, also for a
target whose row is `alreadyIdle`, and never for a replay, which takes no
claim. It is not part of the receipt, whose fields and values are those of
any stop. **With `--server` the warning does not reach the caller:** the
router keeps a remote command's stderr only when the command fails, as for
every warning of a stop (#952).

**On a full disk the stop cannot write into the home either.** The session
is stopped, and the apply answers its receipt (exit 0 in JSON mode) with
that target's row `ok: false`, `E_SESSION_STOP_FAILED`, a `message` that
ends `its harness was signalled (SIGTERM) and has exited`, and
[`stillRunning: []`](#still-running): the row of a stop in a home that
cannot be written, as it was. Read `stillRunning`, not `ok`: `[]` says
stopped. Text mode prints that row, closes with `the stop did not complete
its record; nothing is still running`, and exits 1, as for any target that
failed. The receipt cannot be stored either, so **its key cannot be
replayed**: the same apply again runs, and is answered `E_PLAN_STALE` with
the fresh plan, in which the session is stopped; an apply with that plan's
revision answers `alreadyIdle`, and prints the warning again. Such a stop
leaves nothing of its own in the home: the private file each of the two
writes goes through (`.oats-stop.json.tmp-<pid>`,
`.oats-stop-receipt.<key>.json.<pid>.tmp`) is removed when its write or its
rename fails. Before 0.53.0 each apply on a full disk left both there,
empty. With no record of the stop, the instance then reads
[`sessionEnd: "lost"`](#row-session-end), and a resume sweep would start it
again: stop it once more when the disk has space (a stop of an instance that
reads `lost` records the stop, signalling nothing). The exit marker of the
harness's window (0.69) is not the stop's: the window's shell writes it when
the harness ends, and on a full disk its write fails too.

In 0.52.0 a stop whose claim could not be written for one of those five
codes was refused like the others, before anything was signalled
(`E_LIFECYCLE_FAILED`). Before 0.52.0 a stop took no claim: it wrote its
marker if it could and signalled the harness either way.

Two kernel versions acting on one deployment at once are not covered: a
kernel before 0.52.0 takes no claim for a stop and does not read a stop's
claim. A machine has one installed CLI, and a command routed with `--server`
runs with the host's own, so the only overlap is a command of the old
version still running across an upgrade: upgrade with no lifecycle command
in flight.

- The receipt is `{lifecycleApi: 1, action: "stop", instance, home,
  idempotencyKey, planRevision, at, ok, results, retained: ["home", "work",
  "transcript", "launch"], replayed: false}`. A result is `{instance, home,
  ok: true, stopped, alreadyIdle, state}` or `{instance, home, ok: false,
  code, message, stillRunning: [pid]}`. `code` is `E_SESSION_UNAVAILABLE` when
  whether the instance runs cannot be established, among them a recorded
  tmux socket file that is missing while a process works in the home
  ([#624](execution-targets.md#missing-socket)): never `alreadyIdle`.
- `code` is always a [kernel code](#kernel-codes). A stop that fails for a
  reason of the system's (the home removed under it, a write refused) is
  `E_SESSION_STOP_FAILED`, as one whose harness still runs after the wait is.
  Its `message` then holds the system's text and ends with what is true of
  the harness: `its harness was signalled (SIGTERM) and has exited`, `… and
  is still running`, `no signal reached its harness, which had already
  exited` (the stop found it idle, or its processes gone, when it came to
  signal), `… which was not seen to exit`, `whether its harness was signalled
  is not known`, or `its harness was not signalled`. <a id="still-running"></a>`stillRunning`
  is what the stop established of the processes it signalled, one of three
  values: the pids still alive; `[]` only when the harness exited (its
  processes are gone and the session read as idle); `null` when it
  established nothing, which is a stop that has no answer of its signalling
  step, and one whose signalled processes are all gone while the session
  still does not read as idle (its message says `is still running after <n>
  ms; nothing was escalated`): something runs there that the stop cannot
  name. Only `[]` says stopped. The three values hold from feature
  `lifecycle-kernel-codes`. A kernel without it answers `[]` in a failed row
  for that last case only (all signalled processes gone, the session not
  idle), so there `[]` establishes nothing, and it answers `null` for a
  harness that exited before something else failed. A stop that
  fails on a [defect of the kernel](#kernel-codes) is that same row, and the
  defect's stack is printed on stderr; a stop that fails on a refusal without
  a code (a `tmux` command that failed) is that row and prints no stack. The
  same holds for a child's stop in a retire's `childrenStopped`.
- `ok: false`: at least one target's row is not `ok` (text mode exits 1).
  Whether something still runs is each such row's `stillRunning`, and the
  sentence text mode closes with follows it: `some targets are still
  running; nothing was escalated` when one of those rows names a process or
  establishes nothing (`null`, or no `stillRunning` in the row), and `the
  stop did not complete its record; nothing is still running` when every
  one of them says `[]` (from 0.53.0; before, the first sentence closed
  every such answer).
- A replay is the stored receipt (`<home>/.oats-stop-receipt.<key>.json`)
  with `replayed: true`, and it follows the same rules as a first answer. The
  file a kernel with feature `lifecycle-kernel-codes` stores says so in a
  field of its own, `lifecycleKernelCodes: true`, which is part of the file
  and never of an answer: a replay leaves it out, so a replayed receipt has
  the fields of the first one. A file without that field was stored by a
  kernel from before the feature, and its failed rows are answered under the
  feature's rules: a system's code in `code` becomes `E_SESSION_STOP_FAILED`
  (the `message` keeps the system's text), and `stillRunning: []` becomes
  `null`, which is what that kernel's `[]` established. The stored file is
  never rewritten. A replay takes no claim. The same key sent again while the
  first apply still holds its claims is refused on the claim
  (`E_LIFECYCLE_BUSY`): the receipt is not written yet. Once the first apply
  has ended, the key replays.
- Refusals: `E_BAD_ARGS` (no `--plan-revision`, a bad key, not exactly one of
  `--plan`/`--apply`, a `--grace-ms` that is not 1–300000: answered before
  the plan is read and before the key is used. Before 0.52.0 a bad grace was
  one `E_BAD_ARGS` row per target, in a receipt stored under the key),
  `E_INSTANCE_RETIRING` and `E_LIFECYCLE_BUSY` (a target's claim is held:
  the holder's [`details`](#lifecycle-pairs), with `details.plan`, the plan
  read before the claims), `E_PLAN_STALE` (`details.plan`, the fresh one),
  `E_INSTANCE_RETIRING` for a scheduled self-retire (`details.plan`),
  `E_SESSION_UNKNOWN`,
  `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`, `E_UNIDENTIFIED_INSTANCE_HOME`
  (the home's `instance.json` [cannot be read](#unreadable-record); `--plan`
  and `--apply`, nothing was done), `E_LIFECYCLE_FAILED` (any error
  that is not the kernel's; with [`details.cause`](#kernel-codes) when it has
  a code of its own or is a defect, and without it when it is a refusal
  without a code; among them a claim that cannot be taken for a reason of
  the system's other than [the five a stop reads it for](#stop-claim-write):
  `the claim <path> could not be taken (…); nothing was done`).
  A stop never answers `E_WORK_INSPECTION_FAILED`.

<a id="lifecycle-pairs"></a>
### Commands that meet on one home

Feature `lifecycle-claim-stop`, OATS 0.52.0 (#866). A retire and a stop apply
hold the home's claim for their whole run, and `oats worktree add` reads it;
from OATS 0.69.2 a `session start --resume` holds it too (its rows below).
From feature `lifecycle-claim-start` (#1602) every other `oats session start`
and `oats session restart` holds it for the whole start, a scheduled start
included, as `details.action: "start"`: the `start` row and column. A restart
holds one claim across its stop and its launch, so no retire comes between
the two. A spawn's own first launch takes no claim (a retire already handles
a spawn in progress). A path with no `instance.json` it can read is no home to
hold: a start or a resume of it takes no claim, writes nothing beside it and
answers `E_RUNTIME_ENDPOINT_UNKNOWN`, or `E_UNIDENTIFIED_INSTANCE_HOME` for a
record that cannot be read. A start or restart whose claim cannot be written
is refused `E_LIFECYCLE_FAILED` before any effect, where it used to go on: the
answer names the claim and the reason, nothing is stopped or started, and the
remedy is to make the claims directory writable (only a stop
[goes on without its claim](#stop-claim-write)).
This table covers the commands that arrive on a home; the upgrade pairs and
the resume pairs follow separately.
Each cell is the answer of the command that **arrives**. It is given at once
and before any effect: that command stopped, ran, copied, made and removed
nothing, and the command already on the home is not disturbed.

| On the home ↓ / arrives → | `oats retire` | `oats instance stop --apply` | `oats instance stop --apply` that cannot write its claim | `oats worktree add` | `oats session start` or restart |
|---|---|---|---|---|---|
| a retire is running | `E_LIFECYCLE_BUSY` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` |
| a self-retire is scheduled | `E_LIFECYCLE_BUSY` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` | `E_INSTANCE_RETIRING` |
| a stop apply is running | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_LIFECYCLE_BUSY` |
| a resume is running | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_SESSION_START_BUSY` |
| a start or restart is running | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_SESSION_START_BUSY` |
| a retire whose liveness cannot be read holds the claim | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` |
| a stop whose liveness cannot be read holds the claim | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_LIFECYCLE_BUSY` |
| a resume whose liveness cannot be read holds the claim | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_SESSION_START_BUSY` |
| a start whose liveness cannot be read holds the claim | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | not refused | `E_SESSION_START_BUSY` |
| the claim file is no readable claim | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` | `E_LIFECYCLE_BUSY` |
| the holder of the claim is gone | not refused | not refused | not refused | not refused | not refused |

<a id="upgrade-lifecycle-pairs"></a>
The `instance-upgrade` pairs use the same home's lifecycle claim:

| On the home | Arriving command | Answer |
|---|---|---|
| a retire is running | `oats instance upgrade` apply | `E_INSTANCE_RETIRING` |
| a self-retire is scheduled | `oats instance upgrade` apply | `E_INSTANCE_RETIRING` |
| a stop or upgrade apply, a `session start --resume`, or another session start or restart, is running | `oats instance upgrade` apply | `E_LIFECYCLE_BUSY` |
| a holder's verb is unknown, its liveness cannot be read, or the claim is unreadable | `oats instance upgrade` apply | `E_LIFECYCLE_BUSY` |
| the holder of the claim is gone | `oats instance upgrade` apply | not refused after claim takeover checks |
| an upgrade apply is running | `oats retire` or `oats instance stop --apply` | `E_LIFECYCLE_BUSY` |
| an upgrade apply is running | `oats worktree add` | not refused |
| an upgrade apply is running | `oats session start` or restart, a scheduled start included | `E_LIFECYCLE_BUSY` (feature `lifecycle-claim-start`) |

<a id="resume-lifecycle-pairs"></a>
`oats session start --resume` (OATS 0.69.2, #1559) holds the same claim for
the whole start. What it answers when it arrives:

| On the home | Answer of `oats session start --resume` |
|---|---|
| a retire is running | `E_INSTANCE_RETIRING` |
| a self-retire is scheduled, or a retire is owed (the row's [`retire`](#row-retire)) | `E_INSTANCE_RETIRING` |
| a stop, an upgrade or another resume is running | `E_LIFECYCLE_BUSY` |
| a session start or restart is running (feature `lifecycle-claim-start`) | `E_SESSION_START_BUSY` |
| a holder's liveness cannot be read, or the claim is unreadable | `E_LIFECYCLE_BUSY` |
| the holder of the claim is gone | not refused after claim takeover checks |

The sweep reports each of these `skipped`, `lifecycle-busy`
([the sweep's rows](#the-machine-sweep-oats-session-resume)). An upgrade
apply refuses a home that is not stopped, so it stops nothing: beside a
resume that is still starting, it meets the claim.

Upgrade requires a stopped session. It also keeps a file at the home's
`.oats-start.lock` until its final invocation receipt is persisted. A start
makes nothing at that path and reads it only once it holds the claim, so
beside an upgrade that runs it is refused at the claim (`E_LIFECYCLE_BUSY`);
the file answers (`E_SESSION_START_BUSY`, naming the same-key retry) only
when an upgrade that died left it. A directory at that path is the start lock
of an earlier OATS: a start refuses it with `E_SESSION_START_LOCK_STUCK`,
`<path> is the start lock directory of an earlier OATS; nothing was stopped
or started. Once no earlier oats is running, remove that directory and
retry`, and never removes it. Anything else there is refused with the same
code: `<path> is neither a package upgrade's file nor an earlier OATS's start
lock directory; nothing was stopped or started. Remove it and retry`. An
upgrade apply that meets such a directory answers `E_SESSION_RUNNING`, `<name>:
<path> is a start lock left by an earlier OATS; upgrade never removes it.
Once no earlier oats is running, remove that directory and retry`. A partial receipt refuses starts through the remaining
finalization (`E_UPGRADE_PARTIAL`): the CLI checks it first, before it reads
the home's live teams, except while an upgrade holds the claim, which then
answers. The following stop/retire notes describe the original table.

- **A holder is answered before a stale plan, by both verbs.** A guarded
  retire and a stop apply compare the revision they were sent only once
  they hold the claim, so beside a holder the answer is the cell above
  whatever the plan would read by then.
- **A scheduled self-retire holds no claim** until its completion runs: it
  is its pending marker. The row lasts as long as the marker does: until
  the completion has retired the home, or, from 0.53.0, until a completion
  that did not complete has removed it, which it does unless it started a
  retire hook or began the removal of the home
  ([a completion that does not complete](souls-and-instances.md#self-retire-not-completed)).
  A retire reads the marker under the claim, while
  the completion lives (`E_LIFECYCLE_BUSY`, [below](#retire-one-at-a-time)).
  A stop apply reads it in the plan it makes under its claims: a plan that
  showed `retiring: true` is answered `E_INSTANCE_RETIRING`, and an apply
  whose plan was shown before the retire was scheduled is answered
  `E_PLAN_STALE` first, with the fresh plan.
- **A claim file that is no readable claim** is one that does not parse as
  a claim, a directory, or a path that is there and cannot be read, such as
  a dangling symbolic link. All three commands read it the same way, and
  none removes it.
- **A holder that is gone** (it exited or was killed, a zombie too) refuses
  nothing: a retire or a stop takes its claim over and runs, and a `worktree
  add` takes nothing and runs. One file of a gone holder still refuses the
  two verbs that must take the claim: one this kernel
  [cannot take over](#retire-one-at-a-time) (a `nonce` that is not a
  claim's, written or damaged by hand) answers `E_LIFECYCLE_BUSY`, `holder:
  "none"`, to a retire and to a stop; a `worktree add` reads the same file
  as a holder that is gone, and runs. So does a file that parses and names
  no pid (`{}`, `[]`, a verb alone): a claim
  [always carries its pid](#retire-one-at-a-time), so no kernel wrote that
  file as one. And one race refuses them: a claim that was
  [taken again](#retire-one-at-a-time) by a command that then died, each of
  the five times the retire or the stop found it without a live holder, is
  `E_LIFECYCLE_BUSY`, `holder: "none"`, with `run the command again`.
- **A stop does not refuse a `worktree add`:** a tree does not depend on the
  session. Nor does a resume or a start.
- **Two starts** (a start or a restart arriving beside a start or a resume,
  and a resume arriving beside a start) answer `E_SESSION_START_BUSY`, with
  no `details`, as they did at the start lock before starts took the claim;
  the message begins `another start of <name> is in progress`, or `another
  start of <name> may be in progress` when the holder's liveness cannot be
  read. A resume
  beside a resume stays `E_LIFECYCLE_BUSY`. The resume sweep reports the
  first `start-busy`, the second `lifecycle-busy`, as before.
- **A kernel without `lifecycle-claim-start`** reads a claim whose verb is
  `start` as a retire's: its stop or upgrade beside a new start answers
  `E_INSTANCE_RETIRING`, still before any effect (a 0.69.1 kernel read a
  0.69.2 resume the same way).
- **A stop apply that cannot write its claim**
  ([it reads it instead](#stop-claim-write), OATS 0.53.0) is answered as
  the stop that can, cell for cell. Beside a holder that is gone it stops
  like the other, and leaves that holder's file as it is: it takes nothing
  over. As a command already on the home it has no row: it holds nothing,
  so nothing on the home shows it, and no command that arrives is refused
  by it.
- `--plan` of either verb takes no claim and is never refused by one; a
  stop plan reports the holder (`retiring`, `stopPending`). `oats worktree
  remove` does not read the home's claim. `oats status` does not show a
  held claim.
- **A start or restart refused here started nothing.** From a kernel with
  `lifecycle-claim-start`, a client reads `E_LIFECYCLE_BUSY` and
  `E_INSTANCE_RETIRING` from `oats session start` or `restart` as refused:
  each is answered before the launch and before a restart's stop, and so is
  each one a `--resume` answers. A takeover that ended a dead holder's step
  answers `E_LIFECYCLE_FAILED` instead. For a kernel without the feature, the
  same codes stay uncertain, and a routed start is judged by the host's
  features, not this computer's.

Several targets:

1. **A stop of a parent whose recorded child is being retired** answers
   `E_INSTANCE_RETIRING` before the first target is stopped, never after:
   the claim of every target is taken first, and the claims already taken
   are released.
2. **Two overlapping stops of one parent:** one stops everything, and the
   other is refused whole with `E_LIFECYCLE_BUSY`.
3. **A retire whose recorded child is held by someone else.** A retire does
   not hold its children's claims. It stops each child, and that stop takes
   the child's claim for its own span. A child whose claim is held is a row
   of `childrenStopped` with `ok: false`, `stillRunning: null` and the code
   of the cell above for an arriving stop (`E_LIFECYCLE_BUSY` beside a stop,
   `E_INSTANCE_RETIRING` beside a retire), and the retire answers
   **`E_CHILDREN_RUNNING`**, whether or not it had already stopped another
   child ([`reached.sessionStopAttempted`](#retire-reached) says whether a
   signal was sent). A stop of a child beside its parent's retire is not
   refused.

**`error.details` of a claim's refusal** is `{instance, home, lock, pid,
since, action}`, with `holder` on `E_LIFECYCLE_BUSY`:

- `instance` and `home`: the home whose claim refused. **In a recursive
  stop this may be a child of the instance asked for.**
- `lock`: the file that names the holder. `pid` and `since`: the holder's
  pid and when it took the claim.
- **`action`: the holder's verb**, `"retire"`, `"stop"`, `"upgrade"`,
  `"resume"` (a `session start --resume`, OATS 0.69.2) or `"start"` (every
  other session start or restart, a scheduled start included; feature
  `lifecycle-claim-start`). A claim written
  by a kernel before this feature has no verb and reads as `"retire"`. A
  reader treats a value it does not know as busy.
- <a id="claim-file-text"></a>**Text of a claim file is never part of an
  answer.** A claim is read back as whatever is in its file, and the claims
  of a deployment's homes are in a directory that every instance of it can
  write. A field of the claim that does not have the shape the kernel
  writes is answered as `null` (`pid`: a positive integer; `since`: an
  instant as `2026-01-01T00:00:00.000Z`) and printed as `?` (the recorded
  start: `none`), and an `action` that is not a verb of the list is
  answered as `"retire"`. The same holds for a purpose's claim
  ([`oats worktree`](#oats-worktree)), whose refusal then names no `pid`,
  and for the recorded start of a process group (`details.gitStart`).
- A refusal that names no holder has no `pid`, no `since` and no `action`:
  a claim file that is no readable claim, and a command that cannot read
  its own start time.
- **A scheduled self-retire is no claim.** A retire's refusal beside one
  has the same keys, with `lock` the pending marker and `pid` the
  completion's. A stop apply's has `details.plan` alone, and a `worktree
  add`'s has no `details`; their message is `<instance> is being retired;
  nothing was stopped` (`no tree was made`), with no pid.
- A stop apply's refusal carries `details.plan` beside them: the plan it
  read before it took the claims.
- A holder whose liveness cannot be read: `details.unknown` is the reason,
  and the message names the recorded verb, the pid, its recorded start and
  the way out (check that pid by hand; if it is not that command, remove
  `<lock>`, then retry).

The messages: `<instance> is being retired (pid <pid>, since <at>); nothing
was stopped — if it does not end, check that pid by hand, and if it is not
an oats retire, remove <lock>, then retry` (a `worktree add`: `no tree was
made`); `a stop of <instance> is already running (pid <pid>, since <at>);
nothing was done — wait for it to finish; if it does not end, check that
pid by hand, and if it is not an oats instance stop, remove <lock>, then
retry` (an arriving stop: `nothing was stopped`). The step for a holder
that does not end is [the check of a live process](#busy-holder-running).
A client shows the message and never parses it.

<a id="busy-holder"></a>
**`error.details.holder`, on every `E_LIFECYCLE_BUSY`** of `oats retire`,
`oats instance stop` and `oats worktree add|remove`, for a claim or for
anything else the code is answered for (a tree record, a spawn's marker, a
scheduled completion, an owed rollback). It says, as data, whether waiting
ends the refusal:

| `details.holder` | It means | What ends it |
|---|---|---|
| `"running"` | the kernel established that a process with the recorded pid and start time is alive: the one that the claim, the record or the marker names as an `oats` command (a retire, a stop, a worktree command, a spawn, a scheduled completion). It did not establish that the process is that command | waiting, when it is that command; a claim's refusal also names the check for when it does not end |
| `"unknown"` | whether one still runs cannot be read | a person checks what the message names (the process, the file) |
| `"none"` | nobody is running: something that a dead command left, or that this host lacks, has to be dealt with | what the message says (a file to inspect and remove, a group to end, a command to run) |

A reader treats a value it does not know, or the field's absence (a kernel
without the feature), as **do not promise that waiting ends it**. For
`"unknown"` and `"none"` the message always names the step that ends it,
after ` — `.

<a id="busy-holder-running"></a>
**`"running"` is a live process, not a verified command.** A file that
names any live process by its pid and start time reads as `running`,
whoever wrote it, and waiting for that process ends nothing. So a claim's
refusal for a holder that runs names, after the wait, the check that the
`unknown` refusal names, in the same words: `… — wait for it to finish; if
it does not end, check that pid by hand, and if it is not an oats retire,
remove <lock>, then retry` (`an oats instance stop`, `an oats worktree
command`). `E_INSTANCE_RETIRING` from a claim names the check alone: the
instance is on its way out, so waiting makes neither the stop nor the tree
possible. What a client does with each value of `holder` does not change. The field has a meaning only under `E_LIFECYCLE_BUSY`: under
any other code a reader ignores it (an `E_LIFECYCLE_FAILED` made after a
takeover ended a dead holder's step carries the details of the refusal it
then met, `holder` among them).

<a id="before-effect-codes"></a>
**The codes a stop and a retire answer only before any effect.** The kernel
holds one list, by verb. A code in it means *refused, nothing happened*: no
process was signalled, no hook ran, and nothing of a home was written, copied
or removed. For a retire that is `reached.phase: "before-effects"`, or no
[`reached`](#retire-reached) at all; for a stop apply, that no target's stop
had begun.

| Code | `oats instance stop` | `oats retire` |
|---|---|---|
| `E_BAD_ARGS` | yes | yes |
| `E_USAGE` | yes | yes |
| `E_PLAN_STALE` | yes | yes |
| `E_INSTANCE_RETIRING` | yes | yes |
| `E_LIFECYCLE_BUSY` | yes | yes |
| `E_HOME_MISMATCH` | yes | yes |
| `E_SESSION_UNKNOWN` | yes | yes |
| `E_AMBIGUOUS_INSTANCE` | yes | yes |
| `E_UNIDENTIFIED_INSTANCE_HOME` | yes | yes |
| `E_REMOTE_INCOMPATIBLE` | yes | yes |
| `E_AMBIGUOUS` | yes | yes |
| `E_SNAPSHOT_UNKNOWN` | yes | yes |

The last three are the router's (`--server`): they are answered before the
command is sent to the host. The list is about the envelope's `error.code`.
A row of a result (a stop receipt's `results[].code`, a retire's
`childrenStopped[].code`) says why that one target was not stopped, and
other rows may say that theirs was. Every other code may come after an
effect: `E_CHILDREN_RUNNING`, `E_SESSION_STOP_FAILED`,
`E_RUNTIME_QUIESCE_FAILED`, `E_WORK_PRESERVATION_FAILED`,
`E_WORK_INSPECTION_FAILED`, `E_LIFECYCLE_FAILED` and the rest; for a retire
`reached` says how far it got.

<a id="guarded-apply-plan-event"></a>
**One thing has already happened when a guarded retire apply answers one of
these codes: its plan's append.** A guarded apply reads its plan once it
holds the home's claim, and a plan that is answered appends its
`retire-planned` event to the workspace log, as [a plan](#retire) always
does. Every listed code that the apply answers from there on comes with that
event already appended, in the workspace log only: `E_PLAN_STALE` always,
since the comparison follows the plan; `E_LIFECYCLE_BUSY` or
`E_UNIDENTIFIED_INSTANCE_HOME` when the retire's own first reads then refuse
(the instance is still being spawned; its record became unreadable after the
plan). Nothing of the home is touched and no signal is sent. A stop's plan
appends nothing, and a plain or `--self` retire reads no plan.

The rule holds by construction. Each verb knows how far it got at one place
(a retire: the `phase` it reports in `reached`; a stop apply: whether a
target's stop had begun), and an error that would leave that place with a
listed code after the first effect is not answered with it. It is a
[defect of the kernel](#kernel-codes): `E_LIFECYCLE_FAILED`,
`details.cause: {name: "LateRefusal"}`, its other details kept, and its
stack on stderr.

Two answers of a retire that came after an effect had a listed code before
0.52.0 and have another now (#895):

- A guarded retire whose extra trees no longer read as its plan said, found
  at the step that moves them, after the hooks: `E_WORK_PRESERVATION_FAILED`
  (it was `E_PLAN_STALE`). The home and its work are kept.
- The worktree hook process group that an interrupted spawn left, when it
  survives SIGTERM and SIGKILL: `E_RUNTIME_QUIESCE_FAILED`, naming the group
  (it was `E_LIFECYCLE_BUSY`, "nothing was retired", after two signals).
  `reached.phase` is `"before-hooks"`; no session was stopped, no retire
  hook was run and nothing was removed.

<a id="retire"></a>
### Retire

```text
oats retire <instance> --plan [--home <abs>] [--dir <d>] --json
```

```json
{"lifecycleApi":1,"action":"retire","instance":"dev-1","home":"/w/agents/dev/instances/dev-1","at":"2026-09-28T11:10:00.000Z",
 "facts":{"session":{"state":"shell","present":true,"backend":"tmux","established":true},
          "work":{"observed":true,"revision":"46c20668…","branch":"feat/x","detached":false,"drift":true,"changed":0,"untracked":1,
                  "upstream":{"ref":null,"ahead":null,"behind":null},"base":{"ref":null,"ahead":null,"behind":null},"remote":null},
          "workMode":"worktree","ownWorktree":true,"repo":"/w/one","recordedBranch":"agents/dev-1",
          "children":[{"instance":"dev-1-child","agent":"dev","home":"/w/agents/dev/instances/dev-1-child","session":{"state":"shell","present":true,"backend":"tmux","established":true}}],
          "ambiguous":[],"pullRequest":"unknown",
          "extraWorktrees":[{"path":"/w/agents/dev/instances/dev-1/.work-docs","repo":"/w/docs","branch":"agents/dev-1-docs","detachedAt":null,
                             "disposition":"retain","movedTo":"/w/.agents/worktrees/docs/agents-dev-1-docs","reason":"…"}]},
 "defaults":{"retainWorktree":true,"deleteBranch":false,"stopChildren":true,"retainChildren":true},
 "planRevision":"4e5f6a7b8c9d0e1f2a3b4c5d","notes":["the worktree is on feat/x, not the recorded agents/dev-1; …"]}
```

- `facts.session` and `facts.work` read as a [stop plan](#stop)'s
  `session` and `work`. Work that was not observed is `{observed: false,
  reason}`: `"no-worktree"`, or the kernel code of what failed
  (`E_NO_WORKTREE` for a `work/` that is no work tree of the instance's;
  `E_GIT_FAILED` for an error that has none; `E_WORK_INSPECTION_FAILED` for
  a home the kernel cannot look into, where whether it has a `work/` cannot be
  told; OATS 0.52.0). `facts.work` never reads a checkout that encloses the
  home as the instance's work (0.53.0, #962).
- The plan changes nothing except appending a `retire-planned` event to the
  workspace log. `pullRequest` is always `"unknown"`. Branch actions use the
  worktree's branch, never `recordedBranch`.
- `facts.ownWorktree` (0.53.0, #988, feature `retire-plan-own-worktree`) is
  a fact: a boolean, `true` exactly when `work/` is the instance's own work
  tree, the one this retire retains (moved, as described below) or removes
  (`--discard-worktree`), and `false` for every other home. It is always
  present and never `null`. It is the answer of the one reading of `work/`
  that the retire acts on (below), so it is `true` in `worktree` mode with
  the instance's tree at `work/` (and, by the record, with nothing at
  `work/`: the retire then finds its tree absent), and for a record with no
  work mode whose `work/` Git confirms is a registered linked worktree
  (#962). It is `false` for a directory instance; for an attached, a
  checkout or a workspace instance, whatever the tree its link leads to is
  on; for a real directory that is not the instance's own tree (#962) and
  for a link (#973), under a record that says `worktree` too. It is the
  reading's answer and not a promise that the retire completes: it is
  `true` for a file (or any entry that is neither a link nor a directory)
  at `work/` under a record that says `worktree`, and `false` for one under
  any other record; and it is `true` for a work directory whose Git admin
  entry is missing when the spawn's receipt says that a tree was given,
  whatever the record says but `directory`. No retire removes such an
  entry: it is kept with the home until a person moves it (#1019). Neither
  `facts.workMode` (the record's value, which the instance can write) nor
  `facts.work` (an observation, through any link) says whose tree it is:
  read this key for that. Gate on the probe: from a kernel that lists the
  feature the key is present and a boolean; from one that does not it is
  absent, and its absence says nothing. A stop plan does not carry it. A
  relayed plan (`--server`) carries it as its host answered it, so it is
  the host's features that say whether it is there.
- `defaults.retainWorktree` is the default of one option of this retire:
  whether the instance's own work tree is retained or removed
  (`--discard-worktree`). It follows the fact today: it is `true` when
  `facts.ownWorktree` is. A default is what the retire would do if nobody
  chose and a fact is what is there, so a client does not read this key to
  learn what `work/` is. Where it is `false` the instance has no work tree
  of its own; it is never `false` because a tree would be removed: there
  the retire touches no tree it does not own. `work/` of an attached, a
  checkout or a workspace instance is a link (to its owner's tree, to the
  shared checkout, to the deployment directory) that goes with the home,
  and what it links to is not touched. Where a real directory is found at
  `work/` of such an instance and no link, it is a directory of the home:
  the retire copies it to recovery when it is not empty and removes it
  with the home, and the plan says so (0.53.0, #962: the next item).
  `work/` of a directory instance is the home's own directory: it is
  copied to recovery when it is not empty, then removed with the home. The
  plan's text (`oats retire <instance>
  --plan` without `--json`) prints `retain worktree true` in its `defaults:`
  line for the instance's own tree only; for the other homes the line says
  the above (0.53.0, #959). When the reading of `work/` establishes
  neither an own tree nor a directory of the home, the line says `work mode
  not recorded` for a record with no work mode, and `work mode not known to
  this kernel` for one whose work mode the kernel does not know: the value
  is never printed, and `facts.workMode` holds it. (An own tree under such
  a record prints `retain worktree true`, and a directory of the home its
  own sentence.) The text does not print the fact.
- What `work/` is comes from one reading, which the plan and the retire
  share (0.53.0, #962). It is **the instance's own tree** when the spawn's
  receipt says the instance was given one; for a home without a valid
  receipt, when the record says `worktree`, or holds no work mode (or one
  the kernel does not know) and Git confirms that `work/` is a registered
  linked worktree whose top level it is (the test of an
  [extra tree](souls-and-instances.md#extra-trees-at-retire)). A real
  directory at `work/` that is not that is **a directory of the home**: one
  found where the work mode has a link (an attached, a checkout or a
  workspace instance, or a record with no work mode), or under a valid
  receipt that says no tree was given, whatever the record says now. **A
  link** at `work/` is never the instance's own tree, whatever the record
  says (0.53.0, #973, below). For a directory of the home the plan has:
  - `defaults.retainWorktree: false`, and in the text's `defaults:` line `no
    work tree of its own (work/ is a real directory of the home: copied to
    recovery when not empty and then removed with the home)`.
  - the note `work/ is a real directory of the home and not a work tree of
    the instance's own: the retire copies it to recovery when it is not
    empty (a .git in it included), checks the copy, and removes it with the
    home`, and `recovery: work/ is copied there when it is not empty`. The
    notes that say a worktree is retained, and the drift note, are not said.
  - when Git confirms that the directory is a registered worktree, the note
    `work/ is registered as a worktree of <repository>: the retire leaves its
    entry there until a prune (git -C '<repository>' worktree prune), and does
    not touch its branch or its commits`.
  - `facts.work` by the path alone: observed when `work/` is the top level of
    a repository of its own, else `{observed: false, reason:
    "E_NO_WORKTREE"}`.

  For an own tree whose record names no repository, the plan has the note
  `the record names no repository for the work tree: the retire uses the
  one Git names for it, <repository>, and does not write it into the
  record`. No key of the plan is new.

  <a id="retire-revision-work"></a>**A retire plan's `planRevision` binds
  everything the plan shows, except the facts that move by themselves**
  (0.56.0, #1065), which are these:
  - `at`, the instant of the read;
  - the counts against the branch's upstream and against the default branch
    (`facts.work.upstream.ahead` and `.behind`, `facts.work.base.ahead` and
    `.behind`), and the default branch's name (`facts.work.base.ref`): a
    fetch by anyone who shares the clone moves the remote's refs, and
    creates a missing `origin/HEAD`, where that name is read;
  - a child's session (`facts.children[].session`): a child's process ends
    when it ends, and a child that will not stop refuses the retire by
    itself (`E_CHILDREN_RUNNING`).

  Everything else a plan shows is in its revision, in every home:
  - what the plan reports of the record: its work mode (`facts.workMode`),
    its repository (`facts.repo`), its branch (`facts.recordedBranch`) and
    whether it records a launch;
  - what `work/` is by this reading, with the repository Git names for
    `work/` wherever it is a registered work tree;
  - what Git says of `work/`: the commit, the branch and whether `HEAD` is
    detached, whether that branch is not the one the record names
    (`facts.work.drift`, as the plan shows it: it comes from a second read
    of the record, so it is not derived from `facts.recordedBranch`),
    the counts of changed and untracked files, the branch's upstream by its
    name (`facts.work.upstream.ref`) and the remote's host and path
    (`facts.work.remote`); and where Git gives no answer, the reason
    (`facts.work.reason`);
  - the session as the plan shows it (`facts.session`, whole: its state,
    and the `reason` or the `note` of one that is not established), which
    the record's launch and endpoint decide where the session's receipt
    does not;
  - the home's extra trees (`facts.extraWorktrees`, whole);
  - where a recovery would be written and the declared roots it leaves
    out, as the spawn's receipt gives them: the roots with their owners,
    not the note made from them, which is shortened past its budget and
    then reads alike for two lists of one length. A changed recovery
    exclusion changes the revision (it did not before 0.56.0);
  - of other homes: the children as the plan names them (`instance`,
    `agent`, `home`; a child's agent is the name its soul's file gives),
    the edges that could not be followed (`facts.ambiguous`, whole) and the
    instances attached to this home's `work/` and to each of its extra
    trees, the recorded children and those of a name that is not unique
    alike: the plan's notes name them (#964).

  A key that is derived is bound through what it is derived from:
  `facts.ownWorktree` and `defaults.retainWorktree` (the reading), and
  every note and every line of the plan's text.
  `lifecycleApi`, `action`, `facts.pullRequest` and the defaults
  `deleteBranch`, `stopChildren` and `retainChildren` have one value in
  every plan of a kernel.

  So two plans of one home that differ in anything else they show never
  share a revision, and a guarded apply after one of those things moved (a
  record's work mode, repository or branch that was rewritten, a receipt
  that is gone, an own tree that became a directory of the home, a
  directory of the home that became a work tree of another repository, a
  file where nothing was at `work/`, a receipt that declares another root)
  is refused with `E_PLAN_STALE` and the fresh plan, before anything runs.
  Two reads of a home that nobody touched give one revision.

  Before 0.56.0 the revision held of the record its launch alone, of the
  session its state alone, and the reading only where its answer was not
  the one the record's work mode alone gives, or where the retire took the
  repository from Git because the record named none (0.53.0): a record
  rewritten between a plan and its apply could leave the plan's revision
  as it was.
  **Every retire plan read under an older kernel is stale under this one,
  once:** its apply is refused with `E_PLAN_STALE` and the fresh plan, and
  the person confirms again. A repeated apply with the idempotency key of a
  retire that did run is answered from its stored receipt as before,
  whatever revision it carries: the receipt is looked for before any plan
  is read.
- A link at `work/` is never the instance's own tree: the retire removes
  the link with the home and does not touch what it leads to, whatever the
  record says (0.53.0, #973). The record is a file the instance can write;
  what the link leads to is not the instance's. So a home whose record says
  `worktree` and whose `work/` is a symbolic link plans and retires as a
  home that was given a link. Before 0.53.0 its plan said
  `defaults.retainWorktree: true` and its retire was refused with
  `E_WORK_PRESERVATION_FAILED`. Its plan has:
  - `defaults.retainWorktree: false`, and in the text's `defaults:` line `no
    work tree of its own (work/ is a link, though the record says worktree:
    what it leads to is not touched)`. `facts.workMode` is the record's
    value, as always.
  - the note `the record says work mode worktree, but work/ is a link and
    not a work tree of the instance's own: the retire removes the link with
    the home and does not touch what it leads to, with --discard-worktree as
    well`. The note names no target. It names the flag because a plan takes
    no option: `--plan --discard-worktree` answers this same plan, and no
    worktree step runs for the link with the flag either.
  - `facts.work` as for every home whose `work/` is a link: an observation
    of what the link leads to, which says nothing of whose tree it is.
  - a `planRevision` that binds it, by the rule above: a plan read while
    `work/` was a link is stale once `work/` is the instance's own tree, and
    the other way round.

  Its retire completes with the receipt of a home that was given a link
  (`retention: null`, `worktreeRemoved: false`, no copy of the work in
  `workRecovery`; with `--discard-worktree` too, since no worktree step
  runs), with and without `--discard-worktree` and `--force`, and one string
  in `warnings`: `<home>/work was a link though the record says
  work mode worktree: nothing was retained or removed as a work tree, and
  what it led to (<path>) was not touched`. `<path>` is what the system
  resolves the link to just before the home is removed, never the text
  stored in the link; nothing acts on it. When the link does not resolve,
  the string ends `and it led nowhere that could be read`. The receipt holds
  the path as the system gave it. The retire's text (without `--json`)
  prints every warning of the receipt on one line, spelled as
  [Text output](#text-output) says. The JSON is not changed by that: its
  strings are what they were. No key of the plan or of the receipt is new.
- A link at `work/` that is no longer a link when the retire inspects the
  home again (a retire hook, or anything else, put a directory or a file in
  its place) refuses with `E_WORK_INSPECTION_FAILED` and keeps the home, in
  every work mode (0.53.0, #973): the home's removal would take what is
  there now, uncopied. The message says what was there and what is there
  now, that the home is kept and nothing of it was removed, and how it
  ends, by what is there now:
  - a directory: that `oats retire <instance> --plan` shows what a retire
    would do with what is there now, and that running the retire again does
    that;
  - a file, or an entry that is neither a link, a directory nor a file:
    that no retire removes it, and the step (`move it out of the home or
    remove it, then run the retire again`). It does not point to the plan,
    which does not say that such an entry stays (#1019);
  - an entry that cannot be read: that the retire reads it again when it is
    run again.

  Running the retire again reads the home as it is then, by the reading
  above: the record as it is then and the spawn's receipt decide, not what
  the home was given alone.
  - A directory that the reading answers is a directory of the home (#962:
    the spawn's receipt says that no tree was given, as an attached, a
    checkout or a workspace instance's does, and the record says
    `attached`, `checkout`, `workspace`, `worktree` or holds no work mode):
    the retire copies it to recovery, checks the copy and removes it with
    the home.
  - A directory under a record that says `worktree` whose spawn's receipt
    says that a tree was given, and a file (or an entry that is none of the
    three) under a record that says `worktree` whatever the receipt says
    (an attached instance whose record was changed to `worktree` included):
    a work directory with no Git admin entry. The retire runs its hooks and keeps the entry and the home as an
    incomplete item (exit 1; with `--force` it refuses with
    `E_WORK_PRESERVATION_FAILED` before anything runs) until a person moves
    the entry out or deletes it; then it completes.
  - A file, or an entry that is none of the three, under a record that
    says `attached`, `checkout` or `workspace`: the inspection refuses
    (`E_WORK_INSPECTION_FAILED`, `--force` included, nothing stopped, run
    or removed) until a person removes the entry; then it completes.
  - A record that says `directory` by then is held against the spawn's
    receipt as always: the retire refuses (`E_WORK_INSPECTION_FAILED`,
    nothing stopped, run or removed) while the two disagree.
- The two notes about a worktree that is retained, `N changed and M
  untracked file(s) would be retained with the worktree` and `the worktree
  is on <branch>, not the recorded <branch>`, are given for the instance's
  own tree alone (0.53.0, #973). `facts.work` of an attached, a checkout or
  a workspace instance observes the tree its link leads to, and before
  0.53.0 its plan gave both notes for that tree, which the retire neither
  keeps nor moves. `facts.work` is unchanged.
- A home spawned before 0.25.9 has no session receipt (0.30). Its
  `facts.session` is `{state: "absent", present: false, backend, established:
  true, note}` when the session is observably gone: instance.json records no
  launch, or the recorded tmux server is not running, or the recorded window
  is gone and no pane on that server works in the home, and in every case no
  live process on the host has its working directory in the home
  ([the process scan](souls-and-instances.md#the-process-scan): `/proc` on
  Linux, `lsof` elsewhere; a scan that cannot run counts as not absent). Retire then proceeds
  without quiescing (hooks run, work is preserved). Otherwise it stays
  `unestablished`, with a `note` saying why, and retire refuses with
  `E_RUNTIME_ENDPOINT_UNKNOWN`, `--force` included. `notes` repeats either
  case. Read an unknown `state` as not idle.
- `notes` says what a retire would copy to recovery (0.42), in up to two
  strings read from the home's retirement baseline and the work mode, without
  hashing a file of the home:

  ```text
  recovery: the home is copied to /w/agents/dev/instances/.oats-retirement/recovery before the home is removed, when it changed since spawn; not copied: .aw, .aweb-identity, .aweb-identity-*, .oats-aweb (oats.aweb)
  recovery: uncommitted worktree state is copied there too
  ```

  The first is always present. Its `; not copied: …` tail is there only when
  the baseline records declared home entries
  (`retirement.disposable.home`): `not copied: <roots> (<capability>)`, the
  roots as written in the manifest, in the order the baseline stores them
  (sorted by capability, then root), one group per capability, groups
  separated by `; `. At most 16 roots are listed, and only as many as fit in
  about 1024 characters; the rest are `, and N more`. When not even one
  fits, the tail is `not copied: N declared roots, too long to list here`.
  The recovery path is never cut: when it is too long for the note, the
  note reads `recovery: the home is copied to the recovery directory beside
  the home … (its path is too long for this note: the retire receipt names
  it as workRecovery.path, and the retire summary prints it)`.
  The second is the line above in worktree mode, `recovery: work/ is copied
  there when it is not empty` in directory mode, and absent in checkout,
  attached and workspace modes. They are strings in `notes`: no other key
  changes. From 0.56.0 the declared roots are part of `planRevision`, as
  the baseline gives them and not as the note says them (#1065,
  [the plan's revision](#retire-revision-work)); before it they were not.
- `facts.extraWorktrees` (0.42.1) lists the instance's
  [extra trees](souls-and-instances.md#extra-trees-at-retire): linked
  worktrees at `<home>/.work-*` that Git confirms. It is an array, empty when
  there are none, in every work mode. Each row is `{path, repo, branch,
  detachedAt, disposition, movedTo, reason}`:
  - `path`: the tree's absolute path in the home.
  - `repo`: its repository, the first entry of that repository's `git
    worktree list` (the main worktree, or the bare repository).
  - `branch`: the branch its HEAD is on, or `null`. `detachedAt`: the commit
    when HEAD is detached, else `null`.
  - `disposition`: `"remove"` (the tree is clean: it would be removed, its
    branch kept), `"retain"` (it would be moved to `movedTo`, as `work/` is
    retained) or `"refuse"` (the retire would refuse with
    `E_WORK_PRESERVATION_FAILED` and keep the home).
  - `movedTo`: the target for `"retain"`, else `null`.
  - `reason`: `null` for `"remove"`, why the tree is not clean for
    `"retain"`, why it is refused for `"refuse"`.

  `notes` also carries one string per tree that says the same. When one is
  too long for a note, its longest parts (branch, repository, target,
  reason) are replaced, longest first, by a pointer to `facts.extraWorktrees`;
  the tree's path stays whole, or, when the path alone is too long, the note
  says `an extra worktree whose path is too long for this note …;
  facts.extraWorktrees in the plan JSON lists it`. The trees are
  part of `planRevision`: a tree created, removed, dirtied or cleaned between
  the plan and the apply, or a change of its disposition or target (another
  directory taking the `<leaf>-N` it would move to, for example), refuses a
  guarded apply with `E_PLAN_STALE` before anything runs. A reader that does
  not know the key can ignore it; the `notes` strings say the same.
- Every string in `notes` is at most 4096 characters, and a plan has at most
  64 of them, the limits the Desktop reads (0.49.0, #658). The extra trees
  are the only notes whose number is not fixed: when they would pass 64, the
  last tree note kept says `and N more extra worktrees (facts.extraWorktrees
  in the plan JSON lists every one)`. A note never cuts a name or a path:
  the drift note gives way, longest name first, to a pointer to
  `facts.work.branch` or `facts.recordedBranch`; a session note whose reason
  is too long (a process's command line, a tmux error) points to
  `facts.session.note`.
- A worktree-mode plan whose recorded children include attached instances
  that use this home's `work/` (`instance.json` `work: "attached"`, `work` a
  link to `<home>/work`, directly or through another link) has one note naming them (0.49.0, #718): `attached
  child instance(s) <names> use this home's work/ as their work: a retire
  that keeps the worktree repoints their work link to it; with
  --discard-worktree the worktree is removed and their work link will
  dangle`. It holds for either choice; no other key changes. A relink that
  fails is a string in the receipt's `warnings`.
- The note of an extra tree that recorded children are attached to (their
  `work` is a link to that tree) names them and says what the retire leaves
  them with. For a tree that would be removed it ends `; attached child
  instance(s) <names> use it as their work, and their work link would then
  point at a path that is gone`; for one that would be re-homed, `; attached
  child instance(s) <names> use it as their work, and the retire repoints
  their work link to it`. A tree the retire refuses is neither moved nor
  removed, and its note says nothing of them. Names too long for the note
  give way to `<n> of the recorded children`. They are strings in `notes`: no
  key changes. Who is attached to each tree is part of `planRevision`
  ([what the revision binds](#retire-revision-work)).
- The retire does not act on an instance listed under `ambiguous`, and one
  that is attached to a tree of this home is named with what that leaves it
  with. An extra tree's note gains a clause of its own, after the one for
  the recorded children: `; attached instance(s) <names>, listed under
  ambiguous, use it as their work: the retire does not stop them, and their
  work link would then point at a path that is gone` for a tree that would
  be removed, and `…: the retire neither stops them nor repoints their work
  link, which would then point at a path that is gone (the tree would be at
  <movedTo>)` for one that would be re-homed. For `work/` it is a note of
  its own, in a worktree-mode plan: `attached instance(s) <names>, listed
  under ambiguous, use this home's work/ as their work: the retire neither
  stops them nor repoints their work link, which will then point at a path
  that is gone, whether the worktree is retained (the receipt names where)
  or removed with --discard-worktree`. The note for the recorded children
  above is unchanged.
- `facts.recordedBranch` is `null` where the home records the word `"HEAD"`
  (a detached checkout or attached spawn before 0.49.0, #641): it is not a
  branch name, so `facts.work.drift` is `false` for it as well.

Plain `retire` keeps a worktree-mode instance's work: the worktree is moved
(`git worktree move`) to `<deployment>/.agents/worktrees/<repo>/<branch>` (a
`-2` suffix if taken; `detached-<oid12>` when detached), state intact. The
`<branch>` leaf is the branch flattened to one path component, and a long one
is cut and hashed to fit NAME_MAX
([souls-and-instances.md](souls-and-instances.md#extra-trees-at-retire)). An
extra tree that is not clean is moved the same way; a clean one is removed.

```text
oats retire <instance> [--plan-revision <rev> --idempotency-key <key>] [--discard-worktree] [--home <abs>] --json
```

A flag retire does not read, or an argument after the instance, is refused
with `E_BAD_ARGS` before any effect, `--plan` and `--server` included:
`oats retire: unknown flag <flag>` with `error.details.flag`, or `oats retire:
unexpected argument "<word>" after the instance "<instance>": retire takes one
instance` with `error.details.argument`, each followed by the usage line. The
flags are `--plan`, `--plan-revision`, `--idempotency-key`, `--home`, `--dir`,
`--server`, `--self`, `--discard-worktree`, `--keep-dir`, `--force` and
`--json` ([souls-and-instances.md](souls-and-instances.md#retire)).
A retire with no instance is `E_USAGE`, with the usage line as
`error.message`: one envelope under `--json`, the usage line on stderr
without it. An unknown flag before the instance is still `E_BAD_ARGS`.

A first retire prints the **raw receipt**, not an envelope:

```json
{"retired":"dev-1","agent":"dev",
 "retention":{"worktree":"retained","movedTo":"/w/.agents/worktrees/one/feat-x","branch":"feat/x","detachedAt":null,"recordedBranch":"agents/dev-1"},
 "worktreeRemoved":false,"branchDeleted":false,"removedDir":true,
 "workRecovery":{"path":"/w/agents/dev/instances/.oats-retirement/recovery/dev-1-AbC123",
                 "classes":["changed instance-home bytes","untracked or ignored worktree bytes"],"bytes":48444211,
                 "home":{"paths":[{"path":".oats/","bytes":874696},{"path":".agents/","bytes":141312},{"path":"notes/","bytes":2048},{"path":"STATE.md","bytes":512}],"bytes":1018568},
                 "outputs":{"paths":[{"path":"scratch/","bytes":1258291},{"path":"note.txt","bytes":12}],"bytes":1258303},
                 "notCopied":[{"scope":"home","path":".aw","owner":"oats.aweb"}],
                 "afterHooks":{"home":true,"work":false}},
 "childrenStopped":[{"instance":"dev-1-child","home":"/w/agents/dev/instances/dev-1-child","ok":true,"stopped":false,"alreadyIdle":true}],
 "planRevision":"4e5f6a7b8c9d0e1f2a3b4c5d","idempotencyKey":"r1","replayed":false}
```

- `retention`: `{worktree: "retained" | "removed" | "absent", movedTo?,
  branch, detachedAt?, recordedBranch}`, or `null` when no
  worktree step ran: a non-worktree mode, or a worktree kept for the retry.
  A retire whose hooks left cleanup outstanding keeps the worktree exactly as
  it was (with `worktreeRemoved: false`) and says why in `rollbackIncomplete`
  (`git worktree <path>: kept for the retry; outstanding: …`); the retry does
  the step once nothing else is outstanding. A work directory whose git admin
  entry is gone is never touched: it is an incomplete item (`git worktree
  <path>: its admin entry is missing; …`), and `--force` refuses it with
  `E_WORK_PRESERVATION_FAILED`.
- `--discard-worktree` removes the worktree, and verifies that it is gone (nothing
  at `work/`, not in `git worktree list`); a removal that did not happen, or
  cannot be verified, refuses with `E_WORK_PRESERVATION_FAILED` and keeps the
  home, `--force` included. One exception: with no entry at all at `work/`
  (a dangling link is an entry) and a repository that cannot be read,
  `retention.worktree` is `"absent"`, never `"removed"`, and a quarantine
  retry keeps `could not verify removal` as an incomplete item, which only
  `--force` clears ([souls-and-instances.md](souls-and-instances.md)). No retire deletes a branch, a
  retried or `--force`d quarantine included, with the one exception below.
  `branchDeleted` means exactly "retire's own `--delete-branch`", which is
  refused, so it is always `false`; it does not say whether a branch was
  deleted. `spawnCompensation` (below) is the one place a branch deletion by
  retire is reported. `retention.branchDeleted` and
  `retention.branchDeletionSkipped` are not written. `--delete-branch` is refused with `E_BAD_ARGS` (`oats
  retire no longer deletes branches: …`) before any effect: before a plan
  revision is compared and before a recorded child is stopped. A failed
  spawn's quarantine that still owes the branch the spawn created stays
  incomplete while the branch is there (`the branch the failed spawn created
  is left: OATS does not delete it. Inspect it and delete it with Git if it
  is not wanted, then retry`; the item names no branch:
  `retention.recordedBranch` has it when the worktree step ran, otherwise the
  retained home's `instance.json` `branch`) or while
  Git cannot show it gone (`git branch <b>: could not verify whether it still
  exists (…)`). Such a home cannot be completed from Desktop: the operator
  deletes the branch with Git and retries, or uses `--force` from the CLI.
- **The one exception** (feature `worktree-event`, OATS 0.49.0): a spawn
  killed while its `worktree` hooks ran (SIGKILL, or its rollback cut short)
  leaves a marker with `inProgress.branch` and `inProgress.baseOid`. Once
  that process is verified dead, retire ends the leftover hook process group,
  runs the retire hooks, removes the worktree and verifies the removal, and
  only then deletes the branch with an atomic compare-and-delete (`git
  update-ref -d refs/heads/<b> <baseOid>`), finishing the spawn's own
  compensation: a branch still at its creation commit holds no work. When
  the tip moved, the branch is checked out in any worktree, or the ref cannot
  be read, it is not deleted, and the retry stays incomplete with the
  "branch left" item above (the home is kept). `branchDeleted` stays
  `false` (retire's own `--delete-branch`); the step is reported in the
  additive `spawnCompensation`, the one place such a deletion is reported:
  `{branch, branchDeleted: true}`, or `{branch, branchDeleted: false, reason}`
  (`reason`: the tip moved, it is checked out in a worktree, it could not be
  read, or Git refused), present only when the step was reached. Desktop's
  retire-receipt reader accepts it as an unknown field.
- Before the worktree is removed, HEAD is read again: a HEAD that moved since
  the retire's last inspection stops it with `E_WORK_PRESERVATION_FAILED`
  (`the worktree's HEAD changed after it was inspected, so the worktree was
  not removed. The home and the worktree are kept, and so is any recovery the
  retire wrote; retry the retire.`), and a HEAD that cannot be read with
  `E_WORK_INSPECTION_FAILED`. Either may follow earlier effects of the same
  retire (hooks run, a recovery copied): an error here is not proof that
  nothing happened, nor that a recovery exists. Read
  [`error.details.reached`](#retire-reached), which says both.
- `extraWorktrees` (0.42.1): the extra trees the retire handled, present only
  when it handled at least one. Each row is the plan's row (`{path, repo,
  branch, detachedAt, disposition, movedTo, reason}`) plus `outcome`:
  `"removed"` or `"retained"`, with `movedTo` where a retained tree went. The
  step runs only when the home is removed (not with `--keep-dir`, not when the
  home is kept for a retry), after the hooks and before the worktree step of
  `work/`. `--discard-worktree` does not apply to it. A locked tree
  (`"refuse"` in the plan) stops the retire with `E_WORK_PRESERVATION_FAILED`
  naming the tree before anything runs (no session stop, no retire hook);
  a lock that appears during the hooks, or a move or removal Git refuses,
  stops it at the step, after the hooks. `--force` does not bypass either;
  the home and `work/` are kept, and trees already handled stay handled. A tree
  that no longer matches what the applied plan said refuses with
  `E_WORK_PRESERVATION_FAILED`, the home kept, rather than be moved or
  removed unplanned (OATS 0.52.0; it was `E_PLAN_STALE`, a code that says
  nothing happened, answered after the hooks: #895).
  The key is additive.
- `warnings` also says what the retire left the attached children of a tree
  it moved or removed with, one string per child, for `work/` and for each
  extra tree. A child that could not be repointed to a retained tree:
  `<child>: its work link could not be repointed to the retained worktree
  <movedTo> (<why>) and still points at <link>; repoint it by hand: ln -sfn
  …`, or `<child>: its attachment changed during the retire, so its work was
  left as it is now and not repointed to the retained worktree <movedTo>;
  inspect <home>/work`. A child of a tree the retire removed (a clean extra
  tree, or `work/` with `--discard-worktree`): `<child>: its work was
  <tree>, which this retire removed (<why>); its work link <home>/work now
  points at a path that is gone`. A child that was repointed has no string:
  the text summary's `child <name>` line says where its work now links. No
  key is new.

  An attached instance the plan lists under `ambiguous` is not stopped and
  not repointed, and has a string for each tree that was moved or removed:
  the sentence above for a removed tree, followed by ` (it records this
  instance as its parent under a name that is not unique, so the retire did
  not stop it)`, or, for a re-homed tree, `<instance>: its work was <tree>,
  which this retire re-homed to <movedTo>; its work link <home>/work was not
  repointed and now points at a path that is gone (it records … did not stop
  it); to repoint it by hand: ln -sfn …`. A `--self` retirement's receipt
  does not carry these strings.
- `workRecovery`: `{path, classes, bytes, home, outputs?, repoCopy?,
  notCopied?, afterHooks?}`, present when a recovery was written. One retire
  writes at most one recovery directory, and `path` is that directory.
  - `classes` is the union of the classes seen before and after the retire
    hooks, in first-seen order. `bytes` covers the whole directory,
    `after-hooks/` included.
  - `home`, `outputs` and `repoCopy` describe the pre-hook snapshot (the
    top-level `home/`, `repo/` or `work/`) and are not rewritten by the
    post-hook pass. So `repoCopy.copied: false` (a home-only snapshot) can
    appear with `afterHooks.work: true`: the repository copy is then under
    `after-hooks/repo/` only. A recovery first written after the hooks (the
    instance was clean before them) has no `after-hooks/`, and those keys
    describe that one snapshot.
  - `home`: `{paths: [{path, bytes}], bytes}`. The top-level entries of the
    `home/` snapshot, largest first, a directory ending in `/`. Always
    present when a recovery is written.
  - `outputs`: `{paths: [{path, bytes}], bytes}` names what was copied
    beyond tracked state, largest first.
  - `notCopied`: `[{scope, path, owner}]`, sorted by `path`. The home
    entries that existed at any point of the retire (before or after the
    hooks) and were left out by a capability's `retirement.disposable.home`
    declaration ([capabilities.md](capabilities.md#manifest)), by their real
    names: a prefix that matches several entries lists each one, and a
    declared entry that does not exist is not listed. `owner` is the
    declaring capability; when two declare the same entry it is the first in
    capability-name order. Since 0.42.1 the list also holds each verified
    extra tree (`.work-<purpose>`), with `owner: "kernel:extra-worktree"`: the
    retire handles it at its own step, never in the copy. Each entry has
    exactly these three keys: names and owners only, no sizes, hashes, modes
    or contents of what was left out. `scope` is always `"home"` in this
    release. Present only when there is at least one.
  - `afterHooks`: `{home: boolean, work: boolean}`, saying which parts were
    copied again under `after-hooks/`: `after-hooks/home/` when a retire hook
    changed the home (its bytes and permission bits, the kernel's own
    records included), and `after-hooks/repo/` (worktree mode) or
    `after-hooks/work/` (directory mode) unless the work is proven unchanged
    after the hooks: a directory by its bytes and bits, a worktree by its Git
    state and the bytes and bits of its files
    ([souls and instances](souls-and-instances.md#retire)). A worktree that
    holds a repository is never proven unchanged: for it `work: true` says
    that a work copy was made after the hooks, not that a hook changed the
    work. `work` is also `true` when the pre-hook snapshot held the home
    only and the work was copied for the first time after the hooks, moved
    or not, because something beyond the home was there to preserve. The
    home is not copied again because the work is.
    Each part is whole and verified, not a delta, but `after-hooks/` is not
    a complete picture of the instance after the hooks: with `home: false`
    the recovery's home is the pre-hook one, and it holds the kernel's own
    records (the event log, the stop and restart receipts, listed in
    [souls and instances](souls-and-instances.md#retire)) as of then.
    Present only when that directory was written.
  - `workRecoveries` is no longer emitted. An older kernel on a server may
    still send `workRecoveries[]` beside `workRecovery` (one `{path, classes,
    bytes, outputs?, repoCopy?}` per recovery directory it wrote), so a
    reader must keep accepting it. A kernel before 0.42 sends no `home`,
    `notCopied` or `afterHooks`.
  - `recovery.json` inside the directory stays `version: 1`. It carries
    `phase` (`"before-hooks"`, then `"complete"` once the post-hook check has
    concluded), `home` and, when they apply, `notCopied` and `afterHooks`.
    `phase` is not in the receipt: a receipt is produced only once that check
    has concluded. A retried retire writes its own recovery and its receipt
    names only that one
    ([souls-and-instances.md](souls-and-instances.md#retire)).
- When they apply: `rollbackIncomplete` and `retainedHome` (cleanup
  incomplete, home kept, exit 1), `forcedIncomplete`, `relinked`,
  `capabilityMeta`, `warnings`, `wakeSchedulesRemoved`.
- A deferred self-retire (`--self`) prints `{retired, agent, deferred: true,
  pendingMarker, resultPath, logPath, completesInSec, completionPid}`, or
  `{…, alreadyScheduled: true, requestedAt}` while one is scheduled and its
  completion has not started (below).

**Recorded children**, on every apply (plain, guarded and `--self`), as the
plan says: each child the plan lists is stopped first (bounded SIGTERM,
never escalated) and kept, once the retire has resolved the home and before
the instance's own session is stopped. A home whose `instance.json`
[cannot be read](#unreadable-record) is never stopped as anyone's child: the
plan does not list it, `childrenStopped[]` does not name it, and its session
may go on running after its parent is retired; `oats status` is where it
shows. `childrenStopped[]` lists the children stopped,
deepest first, as `{instance, home, ok: true, stopped, alreadyIdle}` or
`{instance, home, ok: false, code, message, stillRunning}`, where
`stillRunning` has the three values of [a stop's result](#still-running): the
pids still alive, `[]` only when the child's harness exited, `null` when
nothing is established. A plain or
`--self` receipt carries it only when there are children; a guarded receipt
always does (`[]` when there are none). One child still running after the
grace, or whose stop could not be established (`E_SESSION_UNAVAILABLE`,
`E_INSTANCE_RETIRING`, `E_LIFECYCLE_BUSY`, …), refuses everything: nothing is retired, exit 1,
<a id="retire-children-running"></a>`E_CHILDREN_RUNNING {childrenStopped}` (the text form names each child and its
`code`, always a [kernel code](#kernel-codes); the message says `still running after a bounded stop`
only of a child whose row lists processes in `stillRunning`, and `<child> could not be stopped
(<code>)` of any other, OATS 0.52.0). **`--force` does not bypass it**: `--force` covers incomplete
cleanup, not a running child. A `--self` retirement stops the children
recorded when it was scheduled that are still instances (a child retired in
between is skipped), in its detached completion before it stops the caller;
a refusal there leaves the caller's window and home in place and
writes `{ok: false, error: {code: "E_CHILDREN_RUNNING"}, childrenStopped,
retry}` to `resultPath`. Before 0.48.0 only a guarded apply stopped children.

**Guarded apply** (what the Desktop sends): `--plan-revision` and
`--idempotency-key` together.
- A used key replays its receipt as an **envelope** with `replayed: true`
  (receipts live beside the instances directory and outlive the home).
- The revision is checked against a fresh plan: `E_PLAN_STALE {plan}`. That
  plan is read once, when the retire holds the home's claim (below): it is
  the state the retire starts from, and one apply appends one
  `retire-planned` event. Against a retire in flight or a scheduled
  self-retire the answer is `E_LIFECYCLE_BUSY` and no plan is read, whatever
  the plan would read by then: a retire in flight has usually changed it (it
  stops the session of a launched instance before its hooks run). Before the
  claim an apply only replays a used key and resolves the home
  (`E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`,
  `E_UNIDENTIFIED_INSTANCE_HOME` for a home whose `instance.json`
  [cannot be read](#unreadable-record)).
- The children stopped are those of the revalidated plan, and a refusal
  carries it: `E_CHILDREN_RUNNING {childrenStopped, plan}`.
- A first guarded retire prints the raw receipt with `planRevision`,
  `idempotencyKey` and `replayed: false`.

<a id="retire-one-at-a-time"></a>
**One retire of a home at a time** (0.51.0, #863), **and one retire or stop**
(0.52.0, #866: a stop apply holds the same claim,
[above](#stop-claim)). Every retire that applies (plain,
guarded, `--self` and its detached completion; with `--server`, on the host)
holds the home's claim,
`<instances>/.oats-retirement/claims/<instance>.lock`, from the moment it
has resolved the home until it ends, by success or by any refusal or failure.
The claim is a file that names its holder by pid and start time, and by its
verb (`action`: `"retire"` or `"stop"`; 0.52.0). It is written whole to a
private file and linked into place, so a kernel's claim is never seen
without its `pid`: a file there that parses and names no pid was not
written by a kernel as a claim, and a kernel that wrote one without it would
be changing the lock format, which is a contract decision. It lies
beside the homes, never inside one: a home's bytes are what its retire
observes, copies and removes. A second retire of that home, or a retire that
meets a stop of it, does not wait: it
answers `E_LIFECYCLE_BUSY` at once (exit 1; the text form prints the
message), before it stops a session or a child, writes a recovery, runs a
hook or changes a file of the home. **`--force` does not bypass it**, and
`--plan` takes no claim and refuses nothing new. A guarded apply answers it
before `E_PLAN_STALE`: under the claim the answers come in this order: the
home is gone (`E_SESSION_UNKNOWN`), a self-retire is scheduled
(`E_LIFECYCLE_BUSY`), the plan is stale (`E_PLAN_STALE`), then the retire. A claim whose holder has
died, for example a retire killed while its hooks ran, is taken over by the
next retire of that name. So a killed retire can always be run again. A
holder that has exited or was killed and that its parent has not reaped (a
zombie) has died: its claim is taken over without waiting for that reap
(0.52.0, #870; before, the retire was refused as running until the reap). The
claim does not end what the killed retire left running: one of its retire
hooks may still be running when the next retire takes the claim over and
runs the hooks again (#865). Until
that name is retired again its claim file stays where it is, and it is safe
to remove once its pid is gone. A retire that ends removes its claim file;
the `claims/` directory itself stays, empty.

`details` is `{instance, home, lock, pid, since, action, holder}`: `lock` is
the file that names the holder, `since` when the holder took it, `action`
the holder's verb and [`holder`](#busy-holder) whether waiting ends it (both
0.52.0, feature `lifecycle-claim-stop`;
[Commands that meet on one home](#lifecycle-pairs)). Every message is one
line and says that nothing was done:

- A live holder (`holder: "running"`): `a retire of <name> is already
  running (pid <pid>, since <at>); nothing was done — wait for it to
  finish; if it does not end, check that pid by hand, and if it is not an
  oats retire, remove <lock>, then retry`; beside a stop, `a stop of <name>
  is already running …`, with `action: "stop"` and `an oats instance
  stop`. Live is what was established
  [of the process](#busy-holder-running), not that it is that command.
- A holder whose start time cannot be read (where `ps` fails, or a claim
  that records none) is never taken for gone, and its claim is never taken
  over (`holder: "unknown"`). `details.unknown` is the reason. The message
  names the holder's verb, the pid, its recorded start, the reason and the
  way out: check that pid by hand, and if it is not that command (`oats
  retire`, `oats instance stop`), remove `<lock>`, then retry.
- A claim file that is not a readable claim is never removed: a file that
  does not parse, a directory, or a path that exists and cannot be read, such
  as a dangling symbolic link (0.52.0, #874: that one made the retire spin
  without end; it is now refused once its retries are spent, a quarter of a
  second for a retire, which does not wait).
  `details` is `{instance, home, lock, holder: "unknown"}`; the message is
  `<lock> is not a readable claim; nothing was done — inspect it and remove
  it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry`.
- A claim whose holder is gone and that this kernel cannot take over is
  never removed either: its `nonce` is not the 32 hexadecimal digits a claim
  carries (a file written or damaged by hand); or it is the claim of a
  takeover that died (`<lock>.reclaim-<nonce>`), at the end of a chain of
  them so long that the system will not name the claim of one more (each
  adds 41 bytes to the file's name: three to five on a file system whose
  names are 255 bytes at most). `details` is `{instance, home, lock, pid,
  since, action, holder: "none"}`, `lock` being the file the message names.
  The message is `the
  process that held <lock> (pid <pid>) is gone, and this file is not a claim
  this kernel can take over (<why>); nothing was done — inspect <lock> and
  remove it if no oats retire, oats instance stop, oats instance upgrade, oats session start or oats session restart holds it, then retry` (0.52.0, #874; before,
  the first was answered as a live holder, to wait for, and the second as
  `E_LIFECYCLE_FAILED` with the system's `ENAMETOOLONG` about a file that
  does not exist). Removing that one file lets the next retire take the
  rest over. A retire of a name that has no home leaves a file whose nonce
  is not a claim's as it is.
- A claim that is taken again and again by commands that die is an ordinary
  claim, and is not refused with that sentence. A retire takes over the
  claim of a holder that is gone and tries again, five times. When each time
  it found the claim taken again, the last time by a process that is gone,
  `details` is `{instance, home, lock, pid, since, action, holder: "none"}`
  (the last holder's), and the message is `the claim <lock> was found
  without a live holder 5 times and was taken again each time, the last time
  by a process that is gone (pid <pid>); nothing was done — run the command
  again` (a stop: `nothing was stopped`). Nothing is to be inspected or
  removed: the next retire or stop takes that claim over.
- The retire's own start time cannot be read, so it could not hold the claim
  verifiably: `details` is `{instance, home, lock, holder: "none"}`, and the
  message gives the reader's own reason (the `/proc` read, or what `ps`
  answered) and the check to run by hand in a shell on that host: `cat
  /proc/$$/stat` where there is a `/proc`; elsewhere `PATH=/usr/bin:/bin ps
  -o lstart= -o stat= -p $$`, which must print a start time and a state.
  Then the command again.

A scheduled self-retire counts from the moment it is scheduled. Its pending
marker (`pendingMarker`) records the completion process as `completionPid`
and `completionStart` (`null` when the start could not be read). While that
process lives, every other retire of the instance is refused the same way,
`--self --keep-dir` included: `a retire of <name> is already scheduled (its
completion, pid <pid>, requested at <requestedAt>); nothing was done — wait
for it to finish`, with `details.lock` the pending marker, `details.pid` the
completion and `details.since` the marker's `requestedAt`. A completion
whose start cannot be read is refused as a holder's is (`details.unknown`),
the file to remove being the pending marker. A second `--self` answers
`alreadyScheduled: true` only while the completion has not started. While
the first `--self` is still scheduling, or once the completion holds the
claim, it is refused the claim and answers `E_LIFECYCLE_BUSY` like any other
retire, where it answered `alreadyScheduled: true` before 0.51.0. The marker refuses nothing once its completion has
left its outcome at `resultPath` (it failed) or is gone (it died; a
completion that is a zombie, not reaped by its parent, has died: 0.52.0,
#870), nor when
it names no completion (a marker written before 0.51.0): `oats retire
<instance>` then retries the retirement, as before. The completion does not
start its retire while the retire that scheduled it holds the claim: it
waits for that one command, which it knows by the pid and the start time it
was given, for up to ten minutes (`SCHEDULING_WAIT_MS`; 0.53.0; before, for
up to 3 s only). Meanwhile the home has no marker until that retire writes
it, last, and that retire answers a stop and another retire as any running
retire does ([the table](#lifecycle-pairs)). Then it takes the claim as any retire
does, waiting up to 3 s for a live holder, the one that scheduled it
included when the ten minutes have passed; one that meets another retire still running is refused,
and records that at `resultPath` like any failed completion. The `error`
recorded there has the code and the message the same failure has as an
envelope: a kernel code, and what the retire had done by then. From 0.53.0
a completion that does not complete also writes one
[`retire-refused` event](#retire-refused-event), and removes its pending
marker unless it started a retire hook or began the removal of the home.
It removes only the marker of its own scheduling: the same `requestedAt`,
and a `completionPid` that is absent, its own, or of a process that is
gone.

A `--self` that cannot finish scheduling (the completion's log cannot be
opened, no process is created, the marker cannot be written, or, from
0.53.0, its completion has already ended when the marker is written, with
an outcome or without one: the marker is then removed again) answers
`E_SELF_RETIRE_SCHEDULE_FAILED`, with `reached.phase: "before-effects"`. That
stays true after the answer: a completion this command had started is not
running when it answers (it is ended, unless it had gone by itself; a
completion does nothing to the instance before it holds the home's claim,
which the retire that scheduled it holds until it has answered), and its
log and any result it had recorded are removed. One leftover is possible and
is not a debt of the instance: a completion that was kept waiting for the
claim until it gave up may write its result (`E_LIFECYCLE_BUSY`) at the
moment it is ended, after that removal. The next `oats retire` of the
instance removes it. The instance is still live and can be retired
externally.

The home is resolved again once the claim is held. One that another retire
removed in between answers `E_SESSION_UNKNOWN`, as a retire of a retired
instance does. If the name is by then the home of another agent, the retire
starts over on that home, under that home's claim; after two such changes it
answers `E_LIFECYCLE_BUSY` (`the home of <name> changed while its claim was
being taken …; nothing was done — retry`, `details: {instance, home, lock}`).
A retire of a name that has no home also removes a claim of that name whose
holder is gone, left by a retire that was killed after it removed the home.

The claim orders the retires and the stops of a home (0.52.0, #866): `oats
instance stop --apply` takes it, and `oats worktree add` reads it
([Commands that meet on one home](#lifecycle-pairs)), and from feature
`lifecycle-claim-start` a session start or restart takes it too. `oats
status` does not show a held claim. Before 0.52.0 the claim ordered retires only: a stop was not refused
beside a retire in flight, and wrote into the home that the retire was
inspecting or removing.

Refusals (envelopes): `E_PLAN_STALE` (a guarded apply's revision, checked
under the claim: before any effect), `E_CHILDREN_RUNNING`,
`E_WORK_PRESERVATION_FAILED` (the home is kept; retry, or
`--discard-worktree` when it is `work/` that could not be re-homed: it does
not apply to an extra tree; also a guarded retire whose extra trees no
longer read as its plan said, after the hooks: review the fresh plan and
apply again), `E_RUNTIME_QUIESCE_FAILED` (the session's window could not be
shown gone; or the worktree hook process group an interrupted spawn left
survived SIGTERM and SIGKILL: end that group by hand, then retire again),
`E_WORK_INSPECTION_FAILED` (the home is kept; the
message names the entry or the state that could not be read, or the directory
Git reads as the top level of a `work/` whose `core.worktree` names another
one),
`E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`,
`E_UNIDENTIFIED_INSTANCE_HOME` (a home with no `instance.json` and no cleanup
descriptor, or a rollback marker that cannot drive a retry, until `--force`;
a home whose `instance.json` [cannot be read](#unreadable-record), `--plan`
and `--force` included),
`E_NO_ROOT`, `E_LIFECYCLE_FAILED`, `E_LIFECYCLE_BUSY` (another retire of the
home is running or scheduled, or a stop of it is running, `--force`
included: one retire or stop of a home at a time, above; or, feature
`worktree-event`: the home is a spawn still running its `worktree` hooks, a
row with `spawnInProgress: true`, `--force` included; or one whose start time
cannot be read, a `rollbackIncomplete` row, until `--force`; or a hook or git
group whose leader's start cannot be read, until `--force`; every one is
answered before any effect and carries [`details.holder`](#busy-holder)). The
codes a retire answers only before any effect are
[one list](#before-effect-codes). A recovery whose Git status disagrees with
the source's carries `details: {home, statusDisagreement: {repo, rows: [{path,
source, recovery}], total}}` (the first 10 paths). A worktree recovery whose
bytes disagree with the source's (`worktree recovery verification disagreed
with the source`) carries `details: {home, recoveryDisagreement: {basis:
"current", entries: [{path, kind}], complete, stoppedBy?}}`, and the message
names its first 5 entries. The refusal itself is the exact digest comparison
and is unchanged; this report is read only after it refused, from the source
and the copy as they are then (`basis: "current"`), so a source that changed
since its bytes were recorded can show other differences, or none. `kind` is
one of `missing` (in the source, not the copy), `extra`, `type`, `mode`,
`link-target` and `file-content`, nothing is listed below a `missing`,
`extra` or `type` entry, and one path can carry several kinds. `path` is
relative to the worktree, with the same Git paths left out as the
comparison: each printable ASCII byte as itself, a backslash as `\\`, every
other byte as `\xHH`. No content, link target or absolute path is reported,
and an entry that is a link is compared as a link, never followed. Every
read is by path, so what is read is checked against what was listed: a file
must be the regular file it was listed as (opened without following a link
or waiting on a FIFO), and a directory the one it was listed as, before and
after its listing and when the search leaves it; otherwise the search stops
as `unreadable` and nothing found below that directory is reported. A
replacement that is undone before the replaced directory is checked again is
not detected: what was read through it can then be compared and named. Every
path named is relative to the worktree. The search is bounded: at most 20 entries,
200,000 directory entries read (counted as each listing is read, so no
listing goes past the budget), 64 MiB of file bytes read (files are compared
in chunks, sizes first) and 5 seconds, checked between filesystem calls; when it stops early, `complete` is `false` and
`stoppedBy` names why (`discrepancies`, `entries`, `bytes`, `time`, or
`unreadable` when a tree could not be read). Usage errors are text on
stderr, not envelopes.

<a id="retire-reached"></a>
**What a failed retire had done: `error.details.reached`** (feature
`lifecycle-kernel-codes`, OATS 0.52.0). Every error a
retire apply answers once it has resolved the home and holds its claim, a
typed refusal or not, carries it beside its other details. A client shows the
message and never parses it; this is the same statement as data. Gate on the
probe, never on the field: from a kernel that lists the feature an absent
`reached` means the error was answered before the retire of the home began
and nothing was done (below); from a kernel without it an absent `reached`
says nothing.

```json
{"phase":"after-hooks","sessionStopAttempted":true,"hooksStarted":true,"home":"kept",
 "recovery":{"path":"/w/agents/dev/instances/.oats-retirement/recovery/dev-1-Ab12Cd","phase":"before-hooks"}}
```

- `phase`: how far the retire got. `"before-effects"`: nothing of the
  instance was touched and no process was signalled (the first inspection
  is usually here).
  `"before-hooks"`: from the step that stops its recorded children on,
  whether or not that step had anything to signal (then the stop of its own
  session, the second inspection, the copy made before the hooks), until the
  hook runner is called. It begins earlier in one case: a home whose
  interrupted spawn left a worktree hook process group that the retire can
  prove is that spawn's has that group ended before the first inspection, and
  `phase` is `"before-hooks"` from the moment the retire may have signalled
  it. So `"before-hooks"` says neither that a process was signalled nor that
  the children step was reached; `"before-effects"` is never answered after
  a signal. `"after-hooks"`: from
  the call of the retire hooks on (the third inspection, the copy's
  conclusion, the extra trees and the worktree). `"removal"`: from the
  removal of the home on.
- **In the other four fields the untouched value is a guarantee, and the
  other value means only that the retire reached that step, which may not
  have completed.**
  - `sessionStopAttempted`: `false` = this retire sent no signal to the
    instance's session nor to any child's harness. `true` = it began to.
  - `hooksStarted`: `false` = no retire hook was started. `true` = the hook
    runner was called.
  - `home`: `"kept"` = the removal has not begun. Otherwise what is on disk
    when the error is answered: `"partial"` (the removal began and the
    directory is still there: it is no longer guaranteed to be a whole
    instance home) or `"removed"` (it is not there).
  - `recovery`: `null` = no copy of this retire whose manifest can be read.
    Otherwise `{path, phase}`: the absolute path of the copy, and the `phase`
    its `recovery.json` holds on disk when the error is answered
    (`"before-hooks"` or `"complete"`). A removal that fails after a complete
    recovery therefore names where the work is.
- Four points where a step was reached and its outcome is not established:
  the hook process group an interrupted spawn left was signalled and did not
  end (`E_RUNTIME_QUIESCE_FAILED`; `phase: "before-hooks"`, and
  `sessionStopAttempted: false`: that group is no session);
  the kill of the session's window was sent and the check that the window is
  gone failed (`E_RUNTIME_QUIESCE_FAILED`; `sessionStopAttempted: true`, and
  the harness may still run); a child's stop that signalled its harness and
  then failed, or failed while signalling (`sessionStopAttempted: true`); the
  hook runner throwing part-way (`hooksStarted: true`, and some hooks may not
  have run).
- `phase`, `home` and `recovery.phase` are closed lists. A reader treats a
  value it does not know as "effects may have happened".
- It is absent from the answers given before the retire of the home begins,
  where nothing was done: a name that resolves to no home, to several or to
  another one, the claim, a scheduled self-retire, a guarded apply's plan
  (`E_PLAN_STALE` with `details.plan`). It is not part of a plan.

**An error that is not the kernel's** (a file the system refuses to read, a
directory that cannot be removed) is answered with a
[kernel code](#kernel-codes), [`details.cause`](#kernel-codes) (when the
error has a code of its own or is a defect; a refusal without a code has
none), `reached`, and a message that ends with the sentence the typed refusals at that point carry:

| Where it fails | Code | The message ends with |
|---|---|---|
| before the home's retire begins (the resolution, the plan a guarded apply reads) | `E_LIFECYCLE_FAILED`, no `reached` | `Nothing was done: <instance> is not retired.` |
| the claim cannot be taken (its directory cannot be made, its file cannot be written) | `E_LIFECYCLE_FAILED`, no `reached` | `the claim <path> could not be taken (…); nothing was done` |
| an inspection of the home or the work meets an entry it cannot read, or one that is gone when it is read | `E_WORK_INSPECTION_FAILED` | the sentence of its phase: `Nothing was stopped, run or removed.` (or, once it has signalled the hook group an interrupted spawn left, `The worktree hook process group <pgid> that an interrupted spawn left was ended; no session was stopped, no retire hook was run and nothing was removed.`, with `was signalled and may still run` when it is not seen to have ended); `No retire hook has run and nothing was deleted: <instance> is not retired and its home and work are kept; …`; `The retire hooks have run; the home, its work and the pre-hook recovery (if any) are kept; …` |
| anything else before the removal | `E_LIFECYCLE_FAILED` | the sentence of its phase; once the retire has begun to remove or re-home trees, `The retire hooks have run; the home is kept, and so is any recovery the retire wrote; …` and what it has already done with them |
| the removal of the home (a directory that is written into while it is removed, or that cannot be emptied) | `E_LIFECYCLE_FAILED`, `reached.home: "partial"` | `<instance>: the directory at <home> could not be removed: … The retire hooks have run; its recovery (complete) is at <path>; its retired event is recorded; what is left at <home> may not be a whole instance home; …` |

`E_WORK_INSPECTION_FAILED` is answered only by a retire, only before the
removal begins, and only with the home kept (`reached.home: "kept"`). A
typed refusal keeps its code, its details and its own words; the inspections'
and the recovery's refusals end with the sentence of their phase, once.

## An instance's colour (`oats instance color`)

Feature `instance-color` (awebai/oats#1421).

```text
oats instance color <instance> (<color> | --clear) [--home <abs>] [--dir <d>] [--json]
```

The colour is presentation, not identity. Anyone may change it at any time,
the agent on its own instance included, and it is never an address.

- **The palette** is closed: `sand`, `sage`, `slate`, `mauve`, `clay`,
  `olive`, the clients' own (`packages/client/soul-colors.mjs`).
- **The record** is `<home>/.oats-color.json`, `{"colorApi": 1, "color":
  "sage", "at": "<ISO time>"}`, mode 0600, written atomically. `--clear`
  removes it. It is a kernel-owned home file: a capability cannot declare it
  as its own, and it is no change to the home at retire.
- **A reader** takes a regular file only, without following a link, of at
  most 4 KiB. Anything that is not such a valid record reads as no colour
  (`null`), never as an error.
- **The instance** is addressed as `oats instance stop` addresses it, and
  refused with the same answers: not found, ambiguous, a `--home` that is not
  its home, a record that cannot be read.

The answer:

```json
{"instanceColorApi":1,"instance":"dev-a","home":"/w/agents/dev/instances/dev-a","color":"sage","changed":true}
```

`color` is `null` after `--clear`. Setting the colour the instance already
has answers `changed: false` and writes nothing; so does clearing an instance
with no colour.

| Code | When |
|---|---|
| `E_BAD_ARGS` | The colour is not in the palette: `"<value>" is not an instance colour: use one of sand, sage, slate, mauve, clay, olive, or --clear`. Also: both a colour and `--clear`, neither, or two colours |
| *(as `oats instance stop`)* | Instance resolution: `E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`, `E_UNIDENTIFIED_INSTANCE_HOME` |
| `E_INSTANCE_RETIRING` | A retire of the home is in flight (its pending marker, or a live retire holding the home's lifecycle claim, which the command reads and never takes, as `oats worktree add` reads it), or the home is quarantined. Nothing was written |
| `E_LIFECYCLE_BUSY` | The home's claim file cannot be read as a claim, or a retire's liveness cannot be read, as for `oats worktree add` |

Routed with `--server <id>`, the command runs on the host
([Routed reads and plans](#routed-reads-and-plans)); a host whose probe does
not advertise `instance-color` is refused with `E_REMOTE_INCOMPATIBLE`, and
nothing is sent.

Where it is read: `color` on [status rows](#the-roster-oats-status---json),
on [remote roster rows](#the-remote-roster-oats-server-roster---json) (only a
palette name is relayed, anything else is `null`), and on `oats inspect
--home` as `instance.color`. A client draws a row's colour by one rule,
`instanceColor(row)` in `packages/client/instance-presentation.mjs`: the
row's palette name, else none. Colour never says a state alone: a client's
mark keeps the state by its shape.

## Background instances (`oats instance background`)

Feature `instance-background` (awebai/oats#1579).

```text
oats instance background <instance> on|off [--home <abs>] [--dir <d>] [--json]
```

A background instance is listed by the clients under a Background section of
its own. That is all it changes: it spawns, starts, attaches, takes input,
messages, shows in `oats status` and retires like any other. Like the colour,
it is presentation, never identity or policy, and anyone may change it at any
time, a stopped instance's included.

- **At spawn** the value is `--background` or `--no-background`, else the
  soul's `background:` ([soul.yaml](souls-and-instances.md#soulyaml-v2)),
  else `false` ([the preview](#the-preview)). Nothing is inherited from a
  parent, and there is no workspace or host default. A later edit of the soul
  does not move an existing instance: this command does.
- **The record** is `<home>/.oats-background.json`, `{"backgroundApi": 1,
  "at": "<ISO time>"}`, mode 0600, written atomically. Present means
  background; `off` removes it. It lasts as long as the home, through start,
  restart, stop, resume and `oats instance upgrade`. It is a kernel-owned
  home file: a capability cannot declare it as its own, and it is no change
  to the home at retire.
- **A reader** takes a regular file only, without following a link, of at
  most 4 KiB, holding a JSON object with `backgroundApi: 1`. Anything else
  reads as not background, never as an error, and `off` removes it.
- **The instance** is addressed and refused exactly as `oats instance color`
  addresses and refuses it ([An instance's colour](#an-instances-colour-oats-instance-color)),
  with "the background was not changed" where the colour's refusals say the
  colour.

The answer:

```json
{"instanceBackgroundApi":1,"instance":"dev-a","home":"/w/agents/dev/instances/dev-a","background":true,"changed":true}
```

`on` for a background instance and `off` for one that is not answer
`changed: false` and write nothing (`off` still removes an invalid file).
The text answer is `<instance>: background` or `<instance>: not
background`, with ` (unchanged)` when nothing changed.

| Code | When |
|---|---|
| `E_BAD_ARGS` | Not exactly one of `on` or `off`: `give on or off; usage: …` |
| *(as `oats instance color`)* | Instance resolution, `E_INSTANCE_RETIRING`, `E_LIFECYCLE_BUSY` |

Routed with `--server <id>`, the command runs on the host
([Routed reads and plans](#routed-reads-and-plans)); a host whose probe does
not advertise `instance-background` is refused with `E_REMOTE_INCOMPATIBLE`,
and nothing is sent. The same holds for a routed `oats spawn` with
`--background` or `--no-background`; without either flag the route is
unchanged.

Where it is read: `background: true` on [status rows](#the-roster-oats-status---json),
on [remote roster rows](#the-remote-roster-oats-server-roster---json), on
`oats inspect --home` as `instance.background`, and on the soul rows of
[`oats souls`](#oats-capabilities-and-oats-souls) for a soul that declares
it. Each is absent when not background.

## Same work as the parent (`oats instance same-work`)

Feature `instance-same-work` (awebai/oats#1577).

```text
oats instance same-work <instance> on|off [--home <abs>] [--dir <d>] [--json]
oats spawn <soul> … --same-work
```

The flag records that an instance does the same work as its parent. Clients
draw the parent→child line for an instance that carries it. Nothing else in
the kernel reads it: it is not identity, it grants nothing and it never
addresses anything.

- **The record** is `<home>/.oats-same-work.json`, `{"sameWorkApi": 1,
  "parent": "<instance>", "at": "<ISO time>"}`, mode 0600, written
  atomically. Present means on; `off` removes it. It is a kernel-owned home
  file: a capability cannot declare it as its own, a retire does not count it
  as work (on its own it never makes a recovery copy), and `oats instance
  upgrade` does not see it as a change to the home.
- **A reader** takes a regular file only, without following a link, of at
  most 4 KiB, holding JSON with `sameWorkApi: 1` and a non-empty string
  `parent`. Anything else reads as off, never as an error.
- **Bound to the parent.** The flag is on only while the record's `parent` is
  the home's current recorded `parentInstance`. A reparent leaves the record
  naming the old parent, so the flag reads off: a retire's lineage relink
  (the instances pointing at the retiree re-pointed to its parent) and a
  `--relation parent` spawn re-pointing its anchor. `on` binds it to the
  current parent again.
- **Lifetime.** It survives `oats session restart`, a stop and a start, a
  resume (`oats session start --resume`) and `oats instance upgrade`. Only
  `off` and retirement clear it.

**The verb.** The instance is addressed as `oats instance color` addresses
it, and refused with the same answers.

- `on` binds the flag to the instance's recorded `parentInstance`; an
  instance with none is refused. `on` again while the flag is bound to that
  parent writes nothing; `on` after a reparent rebinds it to the current
  parent.
- `off` removes whatever stands at the record's name (a file, a link, a
  directory). It succeeds whether or not the flag was on and whether or not a
  parent is recorded; `off` again is the same answer.

The answer, the envelope's `result`, has exactly these two keys:

```json
{"instance":"dev-a","sameWork":true}
```

`sameWork` is the binding rule read after the write: `true` after `on`,
`false` after `off`. The text answer is `dev-a: same work on` (or `off`).

| Code | When |
|---|---|
| `E_BAD_ARGS` | Neither `on` nor `off`, or more than one word; a `--home` that is not absolute; `on` for an instance with no recorded parent: `<instance> has no parent instance: same work is declared against a recorded parent; the flag was not changed` |
| *(as `oats instance color`)* | Instance resolution: `E_SESSION_UNKNOWN`, `E_AMBIGUOUS_INSTANCE`, `E_HOME_MISMATCH`, `E_UNIDENTIFIED_INSTANCE_HOME` |
| `E_INSTANCE_RETIRING` | A retire of the home is in flight (its pending marker, or a live retire holding the home's lifecycle claim, which the command reads and never takes), or the home is quarantined. Nothing was written |
| `E_LIFECYCLE_BUSY` | The home's claim file cannot be read as a claim, or a retire's liveness cannot be read, as for `oats worktree add` |

**At spawn.** `oats spawn … --same-work` sets the flag on the new instance,
bound to the parent its home records, whichever relation gave it: `--parent
<instance>` or `--relation child`; `--relation sibling` of an anchor that has
a parent (the new instance shares it); `--relation parent` of an anchor that
had a parent (the new instance inherits it); `--work attached` (the owner of
the tree). The record is written inside the spawn, before the launch, so the
instance's first status row carries `sameWork: true`; a spawn rolled back
removes it with the home. When the new instance would record no parent (no
relation, `--relation unrelated`, a sibling of a root anchor, `--relation
parent` of a root anchor), the spawn is refused with `E_BAD_ARGS` before
anything is created, `--preview` included.

Routed with `--server <id>`, the verb runs on the host
([Routed reads and plans](#routed-reads-and-plans)) and `spawn --server …
--same-work` sends the flag there. A host whose probe does not advertise
`instance-same-work` is refused with `E_REMOTE_INCOMPATIBLE` for either, and
nothing is sent.

Where it is read: `sameWork` on [status rows](#row-same-work) and on
[remote roster rows](#the-remote-roster-oats-server-roster---json) (only
`true` is relayed).

## Sessions and launch configurations

### Input

```text
oats session input --home <abs> [--text-file <path>] --json
```

Input bytes come from stdin or the named file. The existing version-1 success
answer is `{schemaVersion: 1, ok: true, result: {home, backend: "tmux",
present: true, state, paneId, submitted: true, verified}}`. Session input runs
on the execution host, including when the wake broker invokes it there;
`--server` is not supported for input. The adapter sends one literal
bracketed paste and one Enter after the existing input/authority/target checks.

**Session input takes no hold.** It types whether or not a claim is set, and
its Enter can answer an open dialog, so don't run it from a script or an agent
at a session that may show one. A person who can see the screen is its intended
caller.

`submitted` means terminal-operation success, **not model acceptance or
processing**. `verified` is display observation only: `true` means a bounded
look changed, possibly because of unrelated output or a dialog; `false` means
unchanged, unreadable or exhausted observation. False never authorizes retry
and is not proof of a pending draft or absence of effects. No `reason` is
emitted; the `enter-not-taken` result from 0.39.4 is removed.

Read-only settling before Enter shares one monotonic 2-second budget starting
when paste returns; up to two post-Enter looks share a 1-second budget. Probe
timeouts and sleeps use the remaining budget. Observation failures produce
`verified: false`, not input errors or extra keys. The original paste/key
command timeouts and `E_SESSION_INPUT_FAILED` errors remain; the observation
budgets do not bound those commands, failed buffer cleanup or OS scheduling.
No busy-pane submission or exactly-once guarantee is provided. Generic command
errors can still be uncertain after partial effects.

The Desktop terminal's authorized PTY writes are a separate stream; they do not
consume this `verified` field. The Pi bridge does not interpret this result.
Scheduler wake still records a nonthrowing input operation as delivered without
adding acceptance/history fields. Actual broker acknowledgement and retry
policy require their own consumer qualification; this result is not a native
harness receipt. See [execution targets](execution-targets.md).

### Start and restart

```text
oats session start --home <abs> [--launch-config <name>|none] [--harness pi|claude|codex] [--model <id>] [--yolo|--no-yolo] [--server <id>] --json
oats session start --resume --home <abs> --json
oats session restart --home <abs> [the same options] [--stop-grace <1-300 s>] --json
oats session resume [--deployment <dir>] [--plan] --json
```

Features `session-start`, `session-restart`, and `launch-config` for the
selection flags. See [the start workflow](desktop-instance-start.md).

Start and restart keep the home's recorded module copies. Their successful
results with package drift include `drift:[{capability, recorded:{version,commit},
locked:{version,commit}}]` for package modules behind the deployment lock,
and omit the field when none are behind. Text prints one line after the start:
`<n> package module(s) behind the lock (<cap> <version> @ <shortcommit> → <version> @ <shortcommit>); to move them: oats instance stop <instance>; oats instance upgrade <instance> --plan`.
`drift` lists only modules an upgrade moves in place. Package modules an
upgrade keeps, because their package is no longer locked or no longer
provides the capability, add one string to `warnings`, printed as a
`WARNING:` line:
`<n> package module(s) cannot move in place (<cap>: package <id> is no longer locked; <cap>: package <id> no longer provides it); an upgrade keeps them as they are, so respawn this instance to move it onto the lock`.
Restart has no upgrade flag. A partial upgrade receipt refuses a start with
`E_UPGRADE_PARTIAL`, naming the retry with the original idempotency key.
A committed receipt with `steps.cleaned: false` permits start and adds one
warning naming the same-key cleanup retry.

- The result is `{instance, agent, home, harness, backend, model,
  launchConfig, yolo, target, startedAt, restartCount, reused, warnings}`,
  plus `nativeRecordId` and `stop` (a restart's stop receipt) when they apply,
  and (0.52.0) `launchPrompts`, the value this start recorded in `instance.json`:
  `{status: "not-engaged", startId, at}` for a start that did not engage the
  development-channel confirmation, `{status: "flag-ignored", reason:
  "channels-unavailable", signatureId, startId, at}` for one where Claude ignored
  the flag (with its warning in `warnings`), or the observed `{status: "completed",
  answers, reason, receipt}`. A `blocked` or `incomplete` outcome is
  `E_SPAWN_INCOMPLETE` instead ([Launch prompt results](#launch-prompt-results)).
- `warnings` (0.30) is always present: an array of strings, the warnings the
  capabilities' `launch` hooks returned for this start (as spawn's
  `warnings`), `[]` when there are none. Each is also appended to the
  instance's events as a `launch-warning` row, `data: {message}`. They are
  advisory: the start went ahead. Earlier kernels omit the field; read a
  missing `warnings` as `[]`.
- The kernel adds one warning of its own, in the same array and as
  the same event: when the start had to create the window again and created
  it on a tmux server other than the one the home recorded, the line names
  the instance, the old socket and the new one (each as a JSON string).
  `target.socket` is then the new socket
  ([execution-targets.md](execution-targets.md#existing-instances)).
- A start or restart appends a `launched` event as soon as its session
  exists (0.40, `phase: "start"` or `"restart"`, `startId`), the session
  boundary that voids earlier waiting claims ([Waiting on you](#waiting-on-you)).
  A start whose metadata write failed has it already, so its adoption adds
  none to a log that holds it and copies it into a log that does not.
- Restart is one command: the kernel validates the new selection before
  stopping, and owns the stop, lock, launch recovery and metadata. Never
  restart by retiring and spawning.
- Launch recovery (0.44.0). A start keeps its launch receipt in the home
  until the next start replaces it. The next start **adopts** a receipt only
  for a start `instance.json` does not record (one whose metadata write
  failed): it records that target and launches nothing again. A receipt for
  a start `instance.json` already records, on the target it records, is
  **completed**, and none of it is recorded again: a newer launch recipe or
  provider metadata stays. A plain start then answers `E_SESSION_RUNNING`
  while that target runs, writing nothing and running no hook; a restart, or
  a start after the target is gone or the harness exited, starts from
  `instance.json` as it is, and its own receipt replaces the old one. A
  receipt that names the recorded start on another target is ambiguous:
  `E_SESSION_UNKNOWN`, the receipt kept, nothing started. The message names
  that target and the way out: stop it, then `oats session restart`, which
  goes ahead once that target no longer runs. Never edit or remove a receipt by hand.
- A recorded tmux socket file that is missing while a process works in the
  home, or the process scan cannot run, is not a stopped server:
  `E_SESSION_UNKNOWN`, nothing started and no server created at that path
  ([#624](execution-targets.md#missing-socket)).
- A lost response does not mean the launch failed: check status before a
  retry. A remote home's saved route names its execution host.
- Errors: `E_BAD_ARGS`, `E_SESSION_UNKNOWN`, `E_UNSUPPORTED_MODE`,
  `E_UNIDENTIFIED_INSTANCE_HOME` (the home's `instance.json`
  [cannot be read](#unreadable-record): nothing was started, `start` and
  `restart`),
  `E_SESSION_START_BUSY`, `E_SESSION_START_LOCK_STUCK` (a start lock
  directory an earlier OATS left at `<home>/.oats-start.lock`, or anything
  else there that is not a package upgrade's file; the message names it and
  what to remove; nothing was started or stopped:
  [Commands that meet on one home](#lifecycle-pairs)),
  `E_INSTANCE_RETIRING`, `E_LIFECYCLE_BUSY` (feature
  `lifecycle-claim-start`: a stop or an upgrade of the home holds its
  lifecycle claim, or the claim cannot be read or taken; `details.holder`,
  `details.action`; nothing was started or stopped:
  [Commands that meet on one home](#lifecycle-pairs)), `E_LAUNCH_*` (among them
  `E_LAUNCH_SHIM`: the home's `oats` link cannot be written, nothing was
  started), `E_MODEL_UNKNOWN`, `E_UNSUPPORTED_HARNESS`,
  `E_CLAUDE_LOGIN_CREDENTIAL` (the effective Claude config has a `/login`
  credential file alongside an OATS-set token; other harnesses are unaffected),
  `E_HARNESS_RESOURCE_MISSING` (a harness package an active capability
  requires is not installed, disabled, or cannot be verified: nothing was
  started; `E_HARNESS_PACKAGE` before 0.56.0), `E_SESSION_FAILED`
  (any error that is not the kernel's; with
  [`details.cause`](#kernel-codes) when it has a code of its own or is a
  defect, and without it when it is a refusal without a code).

#### Resume a lost session (`--resume`)

`oats session start --resume --home <abs> --json` (feature `session-resume`,
OATS 0.69) is the ordinary start of a home whose session was lost
([`sessionEnd: "lost"`](#row-session-end)), in the harness's own last
conversation: the same locks, checks, recorded recipe and launch hooks under
the captured settings, with the conversation's selector and the resume
notice in place of the task prompt
([execution-targets.md](execution-targets.md#resume-after-a-shutdown)). Its
answer is the ordinary start answer plus one object:

```json
"resume": {
  "resumed": true,
  "reason": "no-conversation",
  "harness": "claude",
  "sessionId": "<the harness's session id>",
  "waiting": "resume-confirmation"
}
```

- `resumed: true` with `sessionId` when it continues that conversation;
  `resumed: false` with `reason` when it started fresh on `TASK.md` instead:
  `no-conversation` (no transcript of this incarnation whose cwd is the
  home), `no-receipts` (no native-record receipt of this incarnation names
  where the harness writes), `resume-unproven` (Codex, until a resume of it
  is proven end to end on a signed-in host).
- `waiting: "resume-confirmation"`: the start **succeeded** (exit 0, the
  session runs and is kept) and Claude is waiting for its human to choose how
  to resume a long conversation (its resume-cost dialog). No key was sent.
  Absent otherwise, an unrecognised screen after the bound included.
- Refused before anything is read, `E_BAD_ARGS`: `--resume` with
  `--launch-config`, `--harness`, `--model`, `--yolo`, `--no-yolo` or
  `--reselect-launch`; `--resume` on `session restart`; `--server`.
- It holds the home's lifecycle claim for the whole start (OATS 0.69.2), the
  claim a retire, a stop apply and an upgrade apply hold, so it never runs
  beside one of them: beside a retire it is refused `E_INSTANCE_RETIRING`,
  beside a stop, an upgrade or another resume `E_LIFECYCLE_BUSY`, before
  anything is read or started, and one of them that arrives while it holds
  the claim is refused `E_LIFECYCLE_BUSY` with `details.action: "resume"`
  ([Commands that meet on one home](#lifecycle-pairs)). A path with no record
  it can read takes no claim. Beside an ordinary start or restart, which holds the
  claim too (feature `lifecycle-claim-start`), it answers
  `E_SESSION_START_BUSY`, as it did at the start lock.
- Refused `E_INSTANCE_RETIRING` when the home is owed a retire: its status
  row's [`retire`](#row-retire) has a value (a retire runs, cannot be told,
  failed or was interrupted) or a self-retire is scheduled, read under the
  claim; nothing was started.
- Refused `E_RESUME_NOT_LOST` when the home did not lose its session
  (`stopped`, `exited`, never launched), read under the claim and the start
  lock before any launch hook runs; nothing was started.
- Refused `E_LAUNCH_ENV_CHANGED` when a reference value (`fromEnv` or
  `fromFile`) differs from the one the start it brings back ran with (checked after `E_LAUNCH_ENV_MISSING`):
  the message names the sources (an environment name or `file:<path>`),
  sorted, never a value; nothing was started. A home with no record of its last start's values (last started
  by an earlier kernel, or a record that does not read) is resumed, and
  `warnings` carries once `<instance>'s launch environment could not be
  verified this once (it was last started before OATS recorded it); its
  next start records it` ([The launch environment a resume runs
  under](execution-targets.md#the-launch-environment-a-resume-runs-under)).
- Every refusal of an ordinary start answers as it does there
  (`E_SESSION_RUNNING`, `E_SESSION_START_BUSY`, `E_SESSION_UNKNOWN`,
  `E_LAUNCH_LEGACY` for a home with no recipe, `E_LAUNCH_ENV_MISSING`, …); a
  development-channel prompt that stops it is `E_SPAWN_INCOMPLETE` with
  `details.launchPrompts`, unchanged. A start by hand is neither bounded
  nor counted by the sweep's 3 resumes per home per boot.
- What is persisted is the ordinary launch: `instance.json` `command`, the
  pending receipt and the recipe never carry the selector or the notice, so a
  later ordinary start opens a fresh conversation.

### The machine sweep (`oats session resume`)

`oats session resume [--deployment <dir>] [--plan] --json` (feature
`session-resume`, OATS 0.69) starts with `--resume` every home of this
machine's deployments whose session was lost. A client runs it once when it
opens. It reads this computer's list of deployments without writing it
([This computer's deployments](#this-computers-deployments-oats-deployments)),
and never sweeps one `oats deployments remove` took out;
`--deployment <dir>` sweeps that one directory instead, listed or not. Each
home starts as a child process of the kernel, in its own deployment's scope,
at most 4 at once.

The answer is the standard envelope, exit 0 whenever the sweep ran,
whatever the rows say:

```json
{"schemaVersion":1,"ok":true,"result":{
  "schemaVersion": 1,
  "plan": false,
  "deployments": [
    { "deployment": "/abs/dep", "state": "ok", "swept": true },
    { "deployment": "/abs/gone", "state": "missing", "swept": false, "reason": "not-ok" }
  ],
  "rows": [
    { "deployment": "/abs/dep", "instance": "x", "home": "/abs/dep/agents/s/instances/x", "outcome": "resumed", "sessionId": "…" },
    { "deployment": "/abs/dep", "instance": "y", "home": "…", "outcome": "fresh", "reason": "no-conversation" },
    { "deployment": "/abs/dep", "instance": "z", "home": "…", "outcome": "already-running" }
  ]}}
```

- **`deployments[]`**: one entry per deployment considered, sorted by path.
  `state` is the list's state of it (`ok`, `missing`, `not-a-deployment`,
  `unreadable`). `swept: false` has a `reason`: `not-ok` (its state is not
  `ok`) or `unreadable` (its status could not be read; `code` and `message`
  then). Nothing opts a deployment out: stopping an instance with OATS is
  the only way to keep it down.
- **`rows[]`**: one row per home that is lost (whatever its outcome),
  running (`already-running`) or unknown (`skipped`, `unknown`); stopped,
  exited and never-launched homes are not listed. Fields: `deployment`,
  `instance`, `home`, `outcome`, and only when they apply `reason`, `code`,
  `message`, `launchPrompts`, `sessionId` (resumed) and `warnings` (the
  start's warnings verbatim, an array of strings, present only when not
  empty: a client lists `channel-cache-unchecked` from here), without the
  host-wide ones the sweep's own `warnings` carries.

  | `outcome` | `reason` |
  |---|---|
  | `resumed` | none |
  | `fresh` | `no-conversation`, `no-receipts`, `resume-unproven` |
  | `already-running` | none |
  | `skipped` | `not-seen-recently` (the sweep cannot vouch for this loss: OATS never saw the home running for its current start, an earlier sweep already answered the loss, the loss was first seen 24 hours ago or more, or, within one boot, it was first seen 24 hours or more after the last running look; with a `message` that says which, nothing started: [Which losses come back](execution-targets.md#which-losses-come-back)), `unknown` (running reads `null`, or the start could not establish it: `code` `E_SESSION_UNKNOWN`), `start-busy` (`E_SESSION_START_BUSY`: a concurrent start), `not-lost` (`E_RESUME_NOT_LOST` or `E_SESSION_RUNNING`, or any refusal of a home that is gone: it stopped, started or was removed between the read and the start), `lifecycle-busy` (OATS 0.69.2: OATS is stopping, upgrading or retiring the home, or its retire is owed; read from its row, with a `message`, or answered by its start, with the start's `code`, `E_INSTANCE_RETIRING` or `E_LIFECYCLE_BUSY`, and `message`; nothing started) |
  | `blocked` | `resume-confirmation` (Claude's resume-cost dialog: the session runs and waits for its human), `launch-prompt` (`code` `E_SPAWN_INCOMPLETE`, with `launchPrompts`: the session is kept) |
  | `refused` | `start-refused` (`code` and `message`: the start's own refusal), `refused-this-boot` (an earlier sweep in this boot was refused for this home and start, and its answer to the loss was lost: reported again with that `code` and `message`, nothing started; a refused loss is never retried automatically, after a reboot either), `keeps-getting-lost` (sweeps started this home 3 times in this boot and it was lost again each time: nothing started, no `code`, a `message` that says so; no sweep starts this loss again, after a reboot either: a person starts it by hand) |

  The kernel defines every `sessionEnd`, `resume` and row name in one
  module, `lib/session-resume-contract.mjs`; a change to one is a contract
  change ([#1567](https://github.com/awebai/oats/issues/1567)).

- **`warnings`**, beside `rows`, present only when there is one: an array
  of distinct strings, each a warning the sweep's starts said of the host
  rather than of their home, once whatever the number of starts that said
  it, verbatim. Today that is only the agent-scope warning (the harness
  runs in the OATS tmux server's cgroup, not a scope of its own, and why).
  Each start still records it in its own home's events. `--plan` has none.
- A lost home is answered with the first that applies: `lifecycle-busy`,
  `not-seen-recently`, `refused-this-boot`, `keeps-getting-lost`, then its
  start. A sweep that is not a plan answers each lost home once: a later
  sweep answers that loss `not-seen-recently`. A `lifecycle-busy` row does
  not answer it: whatever OATS was doing to the home decides what it is
  next, and a later sweep reads it again.
- A home whose self-retire is scheduled or owed reads no `sessionEnd`; a
  launched one that does not run is listed `skipped`, `lifecycle-busy`, as
  a lost one is.
- `--plan`: the same shape with `"plan": true`; nothing is started, no lock
  taken, no note written, no loss answered (its own status read records what
  it sees, as any local status read does). A lost home's outcome is the prediction: `resumed`
  (with `sessionId`) or `fresh` with its reason (and the launch-environment
  warning a start would give), `refused` for a noted refusal, a home sweeps
  started 3 times in this boot, a home with no recipe, or a launch reference
  the start would refuse (`E_LAUNCH_ENV_MISSING`, `E_LAUNCH_ENV_CHANGED`,
  from the sweep's environment). Clients should not call `--plan` on open.
- **One sweep per machine.** A second sweep while one runs answers
  `E_RESUME_BUSY` through the standard failure envelope
  (`{"schemaVersion":1,"ok":false,"error":{"code":"E_RESUME_BUSY","message":"…"}}`,
  exit 1); nothing was started, and a client shows no notice. The lock and
  the per-boot note (refusals, and each home's count of sweep starts that
  launched something: `resumed`, `fresh`, `blocked`) are kernel-private,
  not a contract. Without a boot id (neither Linux nor macOS) nothing is
  noted or counted.
- **A lock that needs a person.** `E_RESUME_LOCK_STUCK`, through the same
  envelope at exit 1, when the sweep's lock cannot be taken and no sweep is
  known to run; nothing was started, and no sweep starts anything on this
  machine until it can be. `error.details` is `{lock, found}`: `lock` is
  the lock's absolute path, and `found` is one of

  | `found` | what is at the lock's path | what to do |
  |---|---|---|
  | `unreadable` | a record that cannot be read | remove the file once no sweep runs |
  | `unknown` | a holder that cannot be told to be running or gone | remove the file once no sweep runs |
  | `cannot-take-over` | a gone holder's record that cannot be taken over | remove the file |
  | `held-again` | a lock that was taken again each time the sweep found it free | run the sweep again |
  | `own-start-unreadable` | nothing in the way: the sweep cannot read its own start time, so it could not hold the lock | run the sweep again; nothing is to be removed |
  | `directory` | a directory, the lock of an OATS that locked with one; it is never removed for the operator | remove the directory once no earlier `oats` runs |

  The message says the same in words, with what to do
  ([The sweep](execution-targets.md#the-sweep)). It is never
  `E_RESUME_BUSY`: that code is a sweep that runs. `readResumeSweep` reads
  it as `failed` with the code. `oats doctor --json` lists the same states
  as one `resume-lock-stuck` problem in `problems[]`, `{code, message,
  remedy}` (text: `! resume-lock-stuck: <message>`, the remedy on the next
  line), read without taking the lock; a free lock, a sweep that runs and a
  lock a gone sweep left are not listed, and doctor's exit status does not
  change.
- Errors: `E_RESUME_BUSY`; `E_RESUME_LOCK_STUCK`; `E_BAD_ARGS` (`--deployment` that is not a
  deployment directory, `--server`, an unknown flag or an argument); without
  `--deployment`, the list's own errors (`E_DEPLOYMENTS_INVALID`,
  `E_DEPLOYMENTS_VERSION`). A home's start failure is a row, never the
  sweep's failure.

### The host run (`oats host run`)

`oats host run [--stop-grace <seconds>] [--plan] [--json]` runs
the kernel's periodic work in one foreground process, for a host where no
timer can ([container.md](container.md#what-runs-in-the-container)). It is
this machine's: it takes no `--server`. It runs until SIGTERM or SIGINT.

- **Refused before any effect**, through the standard failure envelope, exit 1:
  - `E_USAGE`: `OATS_INSTANCE_HOME` is set (it runs as the host, never inside
    an instance session);
  - `E_HOST_RUN_TIMER_ACTIVE`: the host timer is active, so two tickers would
    run; `error.details` `{unit}`. Unit files that are installed and not
    active are a warning, not a refusal;
  - `E_HOST_RUN_BUSY`: another `oats host run` holds this machine's lock
    (`<OATS_HOME_DIR>/host-run/lock`, a kernel-private file), or the lock
    cannot be judged; `error.details` `{lock, found}`, `found` as
    `E_RESUME_LOCK_STUCK` names it, and `running` for a host run that runs.
    A lock whose holder is gone, or that was taken in another boot (in a
    container, another run), is taken over;
  - `E_BAD_ARGS`: a flag it does not define, an argument, a `--stop-grace`
    that is not 1 to 300 seconds, a verb other than `run`.

  Any other failure of the run itself is `E_HOST_RUN_FAILED`, which says
  nothing of how far it got. A child that ended without an answer is
  reported under that code too, in `sweep.error` or on stderr, and does not
  end the run.
- **What it runs, in order.** The resume sweep once (`oats session resume`).
  Then at second 0 of every minute: `oats schedule tick --host` when the
  host schedule registry lists a scope, and a listing of every deployment's
  instances, which records what runs for the next start's sweep. Each is a
  child process. A minute whose tick still runs is skipped; a minute missed
  is never replayed. With no scope registered it ticks nothing and says so.
- **On SIGTERM or SIGINT.** No further minute starts; a tick or a sweep that
  runs is waited for; it lists once; then it stops every running home, side
  by side, each with the stop `oats session restart` uses: SIGTERM to the
  harness, a wait of `--stop-grace` seconds (default 20), never escalated.
  Each home's stop record is written before its harness is signalled and
  says `"resume": true, "reason": "host-stop"`, so the home reads
  `sessionEnd: "lost"` and the next start's sweep resumes it. It exits 0.
- **Progress** is one line per event on stderr (`oats host run: …`), in both
  modes. **The answer** is written once, when the run ends:
  `result` `{schemaVersion: 1, plan: false, signal, warnings, sweep, ticks, stopped}`.
  `signal` is `"SIGTERM"` or `"SIGINT"`; `warnings` an array of strings;
  `sweep` the sweep's own `result`
  ([The machine sweep](#the-machine-sweep-oats-session-resume)), or
  `{error: {code, message}}` when it failed (the run goes on); `ticks`
  `{run, skipped, failed, noScope}`, minutes counted; `stopped` one row per
  home that ran when it stopped: `{ok: true, home, stopped, alreadyIdle, state}`
  or `{ok: false, home, code, message, stillRunning}` (`stillRunning`: the
  pids the stop established as alive, or `null`). A home that did not stop is
  a row, never the run's failure.
- **`--plan`** starts nothing, takes no lock and writes nothing: `result`
  `{schemaVersion: 1, plan: true, refusals, warnings, scopes, sweep}`.
  `refusals` is every refusal a run would meet now, in a run's order, each
  `{code, message, details?}`; `scopes` the registered scopes it would tick;
  `sweep` the sweep's `--plan` result. It exits 0 also when `refusals` is not
  empty.

### Upload

```text
oats session upload (--home <abs> | --server <id> --instance <name> | --server <id> --home <abs>) --file <path> --json
```

Feature `session-upload`: copies a file (at most 64 MiB) into the instance's
attachments. Remotely the bytes go on ssh stdin to the host's `session
receive`, and the sha256 is verified.

The result is `{path, bytes, sha256, name, home, source}` (`path` is the
stored file); a remote upload adds `server`, `instance` and `stderr?`. Errors:
`E_BAD_ARGS`, `E_UPLOAD_TOO_LARGE`, `E_UPLOAD_FAILED` (including a remote
sha256 mismatch; the remote file is left), `E_SESSION_UNKNOWN`,
`E_REMOTE_INCOMPATIBLE`.

### How the clients run the sweep

The kernel's machine sweep, `oats session resume --json`
([Resume after a shutdown](execution-targets.md#resume-after-a-shutdown)), is
run by a client when it opens and again when its rosters show a lost session
([When Desktop opens](desktop-instance-start.md#when-desktop-opens)). The
clients share one trigger, one runner and one reader, so the Desktop and the
TUI decide, run and read it the same way.

**The trigger**, `createResumeTrigger({ cli, run, read, now, onReading })`
(`packages/client/session-resume-trigger.mjs`), holds the rule:

- `launch()` arms it and runs the launch sweep, with no floor. A client calls
  it once, after anything the sweep reads is in place (the Desktop: after the
  startup deployments-list step). `observed()` does nothing before it.
- `observed(rows, { localDeploymentIds })` is given each roster's instance
  rows as the client reads them, with the ids of that read's local
  deployments (the Desktop: `instances` of each accepted `/api/panel` reply,
  and `localDeploymentIds(reply)`, its `deployments[]` entries with
  `local: true`). It starts a sweep only when none is in flight, at least
  `RESUME_MIN_INTERVAL_MS` (30 s) has passed since the last sweep that ran
  started, and `lostLocalHomes(rows, localDeploymentIds)` names a home that
  is not settled. Locality is the roster's, by deployment id: a row is local
  only when its `deployment.id` (the panel's tag) is one of the local ids. A
  remote deployment's row, a row with no tag, and every row when no ids are
  given are not local; a client never acts on another host's loss.
  `lostLocalHomes` keeps a local row's absolute `home` when its `sessionEnd`
  says the session was lost and it is not running; it is the one place that
  reads `sessionEnd`'s meaning. There is no timer and no queue.
- After a sweep that a status read started completes (it reads `answered`),
  every instance it was started for waits until it changes: it runs, or it is
  no longer lost. A busy, failed or unsupported sweep, or a plan, settles
  nothing. A home a read releases while the sweep runs is settled by neither
  the snapshot nor the answer: that read is newer. A home
  is also settled when a sweep could not resume it, found it was not lost, or
  skipped it because the kernel had not seen it running recently. A sweep
  that resumed it, started it fresh, left it waiting for you or found it
  running unsettles it, and so does a later roster row that is running or not
  lost. So a home that cannot be resumed costs at most one sweep after the
  launch's. Which rows mean which is read in `session-resume.mjs` alone
  (`sweepSettlement`, `sweepCompleted`).
- `cli()` gives the accepted probe or null, or a promise of either, and is
  asked at each would-be start: the sweep runs only when `resumeSupported`
  holds. When it does not, nothing runs and the floor does not move.
- `read` is given the run's envelope itself, and `onReading(reading)` is
  called for every finished sweep, whatever the reading. `launch()` and `observed()` never throw or reject; a `run` that
  rejects reads as `failed`, `E_CLI_FAILED`. `dispose()` drops later readings
  and cancels nothing: a sweep in flight runs to its end.

The Desktop shows nothing of a reading (the product owner, 2026-10-27): its
main process writes a `failed` reading's code to its log in one line and drops
every other reading. The TUI says nothing of a reading either: an `answered`
reading asks it for a live read, and every other reading for nothing
([Resuming lost sessions](tui.md#resuming-lost-sessions)).

**The runner**, `runResumeSweep` (`packages/client/session-resume-cli.mjs`):

- It runs only when the probe is accepted, its `bin` is absolute and its
  `features` list `session-resume` (`resumeSupported`). Otherwise it runs
  nothing and answers `E_CLI_UNAVAILABLE` or `E_RESUME_FEATURE`. Nothing falls
  back.
- The argv is exactly `session resume --json`, with no `--deployment`, no
  `--plan` and no `--server`. The working directory is `/`, so the kernel
  resolves no deployment from the client's own. The environment is the
  client's, without what Desktop's packaging adds (`cliEnvironment`) and without
  the instance variables (`withoutInstanceVariables`,
  `packages/client/kernel-environment.mjs`): a client started inside an
  instance's pane must not scope the sweep to that instance. `OATS_HOME_DIR`
  passes through.
- It sets no deadline. The sweep runs in a process session of its own, and its
  stdout and stderr are files, not pipes: `execFileToFiles`
  (`packages/client/file-output-exec.mjs`) unlinks them right after the spawn
  and reads them back from its own descriptors. Neither the client's exit nor
  a signal to it reaches the sweep, and nothing is left on disk. A caller that
  passes its own exec must keep those three properties: detached, file-backed,
  and never signalling the child.
- It answers the kernel's envelope: the result at exit 0, and an `ok:false`
  envelope whatever the exit (`E_RESUME_BUSY` and `E_RESUME_LOCK_STUCK` exit 1). Otherwise it answers
  a code of its own, with no message: `E_CLI_OUTPUT_LIMIT` (more than 4 MiB),
  `E_CLI_PROTOCOL` (no envelope), `E_CLI_FAILED` (a nonzero exit without an
  `ok:false` envelope, or an exec that throws). No stderr and no exception text
  reaches the answer.

**The reader**, `readResumeSweep` (`packages/client/session-resume.mjs`),
gives one of four readings: `unsupported` (`E_CLI_UNAVAILABLE` or
`E_RESUME_FEATURE`: nothing ran), `busy` (`E_RESUME_BUSY`), `failed` with a
code, or `answered`. A reading carries nothing of the answer's rows or words.

- `answered` is every `ok: true` answer whose result is the sweep's document,
  a plan (`plan: true`) included. A plan started nothing, so it completes
  nothing: its snapshot and its rows settle no home (`sweepCompleted`,
  `sweepSettlement`).
- `failed` carries the refusal's code when it matches `^E_[A-Z0-9_]{1,64}$`,
  else `E_CLI_PROTOCOL`. An `ok: true` answer that is not the document (no
  `schemaVersion` 1, `plan` not a boolean, `deployments` or `rows` not an
  array, or either longer than 100 000 entries) is a protocol failure,
  `E_CLI_PROTOCOL`, and is never read in part.

### Launch configurations

```text
oats launch-config list [--dir <d> | --home <abs> | --soul <name> [--dir <d>] [--agents-root <abs>]] --json
oats launch-config set <name> --file <definition.json | -> [--keep-env] [--dir <d>] --json
oats launch-config remove <name> [--dir <d>] --json
oats launch-config preview (--home <abs> | --soul <name> [--dir <d>]) [--launch-config <name>|none] [--harness <h>] [--model <id>] [--yolo|--no-yolo] --json
```

Feature `launch-config`. Configurations are a host choice in
`oats-local.yaml` `launch-configs:` ([syntax](configuration.md)). All four
accept `--server <id>`.

```json
{"context":"/w","level":"/w","file":"/w/oats-local.yaml","selected":null,
 "configurations":[{"name":"reviewers","harness":"claude","executable":null,"args":["--permission-mode","plan"],
                    "env":{"ANTHROPIC_API_KEY":{"fromEnv":"REVIEW_KEY"},"CLAUDE_CODE_OAUTH_TOKEN":{"fromFile":"/etc/agent-login/claude-token"},"REVIEW_MODE":{"redacted":true}},
                    "model":"opus","yolo":null,"default":false,"source":"/w/oats-local.yaml","shadows":[]}]}
```

- **list**: `selected` is `null`, `{home, instance}` or `{soul, agentsRoot}`;
  `level` and `file` are `null` without an `oats-local.yaml` (the set is then
  empty). An environment literal is `{redacted: true}`, a reference
  `{fromEnv: NAME}` or `{fromFile: /absolute/path}`; resolved values are never
  returned. File references hold credential values; directory selectors require
  a literal or `fromEnv` ([configuration.md](configuration.md)). `default`
  (0.32, feature `launch-config-default`) is always a boolean: `true` marks this host's
  default for the configuration's harness.
- **set**/**remove**: `{name, action, level, file, before, after,
  effective}`. `set --file` takes `{harness, executable?, args?, env?, model?,
  yolo?, default?}` (`-` reads stdin); it replaces the whole entry and refuses
  a key it does not know, so an editor sends `default` back to keep it.
  `default: false` is written as its absence. A second `default: true` for a
  harness is `E_LAUNCH_CONFIG_INVALID` with `details: {harness,
  configurations: [<the declared one>, <this one>]}` and nothing is written;
  moving the default is two writes, never an automatic move. `--keep-env`
  keeps the declared environment when `env` is omitted. Routed with
  `--server`, a definition with `default: true` to a host that does not
  advertise `launch-config-default` is `E_REMOTE_INCOMPATIBLE` before
  anything is sent (`default: false` is dropped). Errors: `E_LOCAL_MISSING`,
  `E_BAD_ARGS` (including `--home`/`--soul`), `E_LAUNCH_CONFIG_UNKNOWN`,
  `E_LAUNCH_CONFIG_INVALID`, `E_CONFIG_BROKEN`, `E_HOME_UNKNOWN`,
  `E_REMOTE_INCOMPATIBLE`, `E_LOCAL_BUSY {path, lock}`, `E_LOCAL_CHANGED
  {path}`.
- **The write** (`set`, `remove`) replaces the `launch-configs` block and
  leaves every other byte of the file as it was. It is made under
  `<deployment>/.agents/locks/local.lock`, the lock of every kernel command
  that rewrites `oats-local.yaml` ([`oats teams`](#oats-teams) says what it
  covers), from the file as it is under that lock: whether the name is
  declared, `before`, the environment `--keep-env` keeps and the one default
  per harness are all read there, never from the command's start. The
  definition (`--file`, or stdin) is read and judged before the lock is
  taken. A lock still held after 5 s is `E_LOCAL_BUSY`, and a file that kept
  changing while the edit ran is `E_LOCAL_CHANGED`; nothing was written, and
  the same command can be run again. When the text it would write is the
  file's text already, nothing is written; the receipt is the same either
  way. (The same definition set again is such a case only once this command
  has written the block: a block written by hand in another form is
  rewritten in this command's.)
- **preview** (read-only) answers `{context, selected, selection: {source,
  launchConfig, harness, model, yolo}, harness, model, modelSource, yolo,
  launchConfig, launchConfigSource, launchConfigDefault, executable: {path,
  declared, resolvedFrom}, argv, environment: [{name, fromEnv} | {name, fromFile}
  | {name, redacted: true} | {name, reference: true}], command (redacted), prompt, hooks,
  preflight: [{check, ok, detail, code?}], ok}`. A failed check carries the
  code a start would refuse with; the `harness-packages` check's is the
  gate's own, `E_HARNESS_RESOURCE_MISSING` (`E_HARNESS_PACKAGE` before
  0.56.0). A fault of the gate, which is no verdict on a package, is not a
  row: the preview fails as a whole.

`launchConfigDefault` (0.32) is `true` when `launchConfig` is this host's
default for the harness rather than a chosen configuration; the spawn preview
carries the same top-level field, `instance.json` records it as
`launch.launchConfigDefault: true`, and `inspect --json` of a home answers
`instance.launchConfig` and `instance.launchConfigDefault`. The closed `Launch`
object is unchanged: its `effective.launchConfig` names the default
configuration.

A successful envelope can carry `ok: false`: show the failed `preflight`
checks. The prompt is named, never the task body. A home predating launch
recipes answers its frozen command with `selection.source: "frozen-command"`
and `hooks: null`; a selection on it is `E_LAUNCH_LEGACY`. Editing a
definition never changes a running instance's recipe.

<a id="schedules-and-triggers"></a>
## Schedules and triggers

Schedules (feature `schedule`, `scheduleApi: 2`; history feature
`schedule-read-2`, `scheduleHistoryApi: 3`), triggers (feature `triggers`,
`triggerApi: 1`) and workspace automations (feature `automations`,
`automationsApi: 1`). Model: [schedules.md](schedules.md#triggers).

The lists stay separate: a trigger never appears in `schedule list`, nor a
schedule in `trigger list`. Each answers this machine's local items and every
workspace item of a readable member. Render the rows; never re-derive them.

### `oats schedule`

```text
oats schedule list [--dir <d>] --json
oats schedule show <id> --json
oats schedule update <id> --description=<text> [--dir <d>] --json
```

```json
{"scope":"/w","scheduleApi":2,"scheduleHistoryApi":3,
 "integrity":{"sources":[{"path":"definitions","status":"ok","bytes":1206},{"path":"state","status":"ok","bytes":4410}]},
 "host":{"name":"ana-laptop","ghUser":{"github.com":"ana"}},"triggers":{"count":4,"command":"oats trigger list"},
 "snapshot":{"takenAt":"2026-09-26T19:58:09.281Z","problems":1},
 "schedules":[{"id":"nightly","kind":"spawn","cron":"0 7 * * *","tz":"Europe/Madrid","agent":"rm","task":"Check the release branch.","purpose":"nightly",
               "enabled":true,"createdAt":"2026-09-26T19:58:09.380Z","updatedAt":"2026-09-26T19:58:09.380Z","scope":"/w","scheduleApi":2,"scheduleHistoryApi":3,
               "executionStatus":{"kind":"legacy","capture":"unknown","migrationRequired":true},
               "nextRun":"2026-09-29T05:00:00.000Z","nextDue":"2026-09-29T05:00:00.000Z","lastRun":null,
               "history":{"status":"ok","stored":1,"truncated":false},
               "recentRuns":[{"scheduledFor":"2026-09-28T05:00:00.000Z","startedAt":"2026-09-28T05:00:01.000Z","kind":"spawn","outcome":"ended",
                              "runId":"3f9a0b1c2d3e4f5a6b7c8d9e","legacy":false,"settled":true,"recordedAt":"2026-09-28T05:40:00.000Z","transitions":["started","ended"],
                              "session":{"instance":"rm-nightly","home":"/w/agents/rm/instances/rm-nightly","incarnation":"2026-09-28T05:00:01.000Z","server":null,"delivery":"launched"}}],
               "running":false,"name":"nightly","qualifiedId":"local/nightly",
               "origin":{"kind":"local","path":"oats-schedules.json","url":null,"localPath":"/w/oats-schedules.json"},
               "description":null,"owner":null,"runsOn":null,"runsHere":true,"reason":null,"enabledHere":true,
               "soul":{"name":"rm","origin":{"kind":"member","repoKey":"github.com/nw/agents","member":"agents"}},
               "teams":[],"launchConfig":null,"harness":null,"model":null,"concurrency":null}],
 "scheduler":{"installed":true,"active":true,"registered":true,"lastTick":"2026-09-28T11:59:00.000Z","maxConcurrent":2}}
```

- `list`: `{scope, scheduleApi, scheduleHistoryApi, integrity, host,
  triggers, snapshot, schedules, scheduler}`; `triggers` counts the trigger
  definitions left out. `show <id>`: `{schedule}`, without `integrity`.
- `update <id> --description=<text>` without `--file`/`--spec-json` (feature
  `automation-descriptions`) changes only a local schedule's description,
  any kind's (a command schedule too), and is allowed while the job runs or
  has an unresolved attempt. `--description=` (empty) removes it. It answers
  `{schedule}` (the row `show` answers). A workspace schedule refuses
  `E_AUTOMATION_WORKSPACE`; out of the rule is `E_SCHEDULE_INVALID {field:
  "description"}`. Run it as argv, without a shell, always in the `=` form.
  An older kernel refuses it as a missing `--file`.
- **A readable row**: the definition (`id, kind, cron, tz, enabled, …`, and
  `agent/task/purpose/harness` for a spawn, `argv/cwd` for a command, the
  message for a wake, the operation for an operation) plus `scope,
  scheduleApi, scheduleHistoryApi, executionStatus, nextRun, lastRun, history,
  recentRuns, running, attempt?, pendingWake?` and the
  [shared row fields](#automations-shared-rows).
  `executionStatus` is `{kind: "legacy" | "invalid", capture: "unknown",
  migrationRequired: true, reason?, intent?}`; only `legacy` runs.
- **`attempt`** (present while a launch has no recorded result; reconcile
  resolves it): `{scheduledFor, startedAt, wallClock, error?, exited?,
  exitStatus?, exitSignal?}`. `error` (0.40.0) is the first run's cause. A
  `command` or `operation` attempt with `exited: true` (0.40.0) holds no host
  slot (`running: false`) but still blocks its own job; show it as needing
  `oats schedule reconcile <id>` (or `--clear`) either way.
- **Schedule IDs**: local and workspace schedule definition names permit 1–100
  lowercase letters, digits and dashes; trigger names retain their 40-character
  limit. Desktop accepts these schedule names for creation, editing and row
  actions (enable, disable, test, run and reconcile), including qualified IDs.
  A spawn's derived instance name still has a 64-character limit.
- **`description`**: the [shared row field](#automations-shared-rows).
  Desktop preserves it unchanged through edits to timing and other fields.
- **An unreadable row** (`list` only): `{id, scope, scheduleApi,
  scheduleHistoryApi, unreadable: {code, message}, history: {status:
  "corrupt", stored: null, truncated: false}, recentRuns: []}`. One bad job
  never fails the others.
- `history`: `{status: "ok", stored, truncated}` or the corrupt form; capped
  at 50 rows.
- **A run** (`recentRuns[]`, `lastRun`): the producer's fields
  (`scheduledFor, startedAt, kind, outcome, …`) plus `runId, legacy: false,
  settled, recordedAt, transitions, session`.
  - `runId` = `sha256(scheduledFor|startedAt|attemptId)[0:24]`, opaque: never
    recompute or dedupe by it. `lastRun` shares its history row's `runId`.
  - `transitions` is the outcome sequence; `settled` a boolean. `outcome` is
    the producer's word (`ended`, `stopped`, `blocked`, `invalid`,
    `delivered`, `skipped`, `unknown`, …).
  - A pre-API-3 row: `runId: null, legacy: true, settled: null, transitions:
    null`, `session`, no `recordedAt`. A corrupt element: `{runId: null,
    legacy: true, corrupt: true}`.
  - `session` is `{instance, home, incarnation, server, delivery: "launched"
    | "delivered-active" | "none"}`: recorded provenance, not a transcript
    reader.
  - `warnings?` (feature `schedule-run-warnings`): the launch answer's
    warnings, strings, present only when it had some (a spawn job's spawn, a
    wake that started its session). For example, that the OATS tmux server
    was started inside the tick's systemd service
    ([execution targets](execution-targets.md#a-server-started-from-inside-a-systemd-service)).
    A later run of the same record never keeps an earlier run's.
  - `held?` (feature `wake-hold`): on a wake held by a claim, `{since,
    claimReason, producer, unreadable?}`, beside `reason: "waiting-on-you"`
    and `pending: true`. `pendingWake` then carries `heldSince`. A later run of
    the same record that isn't held keeps neither `held` nor that `reason`
    ([A held wake](schedules.md#a-held-wake)).
- `nextDue` is "when it next runs" in every row (`null` when another host
  runs it); a schedule row also keeps `nextRun`.
- **Integrity.** `oats-schedules.json` and `.agents/schedules/state.json` are
  opened as regular files only, at most 1 MiB. `integrity.sources[]` is
  `{path: "definitions" | "state", status: "ok" | "absent" | "refused" |
  "oversize" | "corrupt", bytes}`.
- Refusals: `E_SCHEDULE_STATE_OVERSIZE` and `E_SCHEDULE_INVALID` (`details:
  {source, field?}`), `E_SCHEDULE_IDENTITY` (`details: {key, declared}`), and
  `E_BAD_ARGS` for an id not matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
  `list` refuses as a whole only when a scope file is unreadable.

**Other verbs** (envelopes):
- `add <id> (--file <spec.json> | --spec-json <json>)`, `update`, `enable`,
  `disable` → `{schedule}`. `run [--force]`, `remove [--force]`, `reconcile
  [--clear]` → the action's receipt. `tick [--dry-run] [--host]` →
  `{tickedAt, considered, scheduler}`; `host install` → `{scheduler, warnings}`;
  `host install --register-only` → the same answer, the scope recorded in the
  host registry and no unit installed (`scheduler.registered: true`,
  `installed: false`, `warnings: []`), for a host whose ticker is
  [`oats host run`](#the-host-run-oats-host-run); it does not go with
  `--print` (`E_BAD_ARGS`);
  `host uninstall | status` → `{scheduler}`; `host install --print [--os
  darwin|linux]` → `{kind, files: {<path>: <content>}, warnings}`, writing
  nothing.
- `test <id>` → `{test: {id, qualifiedId, kind, placement: {runsHere, reason,
  reasonDetail?, enabledHere, runsOn, owner, host}, soul: {name, origin,
  resolves, error} | null, nextDue, spawned: false, problems, ok}}`. The soul
  is checked as the run would start it; not running here, disabled, invalid
  or unresolved is a problem. It runs nothing.
- Errors: `E_SCHEDULE_UNKNOWN`, `E_SCHEDULE_EXISTS`, `E_SCHEDULE_INVALID`,
  `E_SCHEDULE_RUNNING`, `E_SCHEDULE_DISABLED`, `E_SCHEDULE_UNRESOLVED`,
  `E_SCHEDULE_FAILED`, `E_LOCAL_MISSING`, `E_BAD_ARGS`.

### `oats trigger`

```text
oats trigger list | show <id> | status [<id>] | test <id> [--run-source] | poll <id> --run-source [--max-age <s>] | add (--file <json> | --from <package>:<template> [--set k=v]) [--description=<text>] | update <id> --description=<text> | enable <id> | disable <id> | remove <id> --json
```

Event-driven spawns. Local definitions live in `oats-schedules.json` (`kind:
"trigger"`). A trigger's source is the built-in `github.pull_request` or, with
feature `trigger-sources`, `<capability>:<source>`, a source a
capability declares ([schedules.md](schedules.md#capability-sources)).

- `list`: `{triggerApi, scope, host, snapshot, triggers, scheduler}`.
  `show`, `add`, `update`, `enable`, `disable` → `{trigger}`; `remove` → `{removed,
  live: [instance]}`. A stored definition that no longer validates carries
  `invalid: {code, message, field?}`.
- **A trigger row**: the [shared row fields](#automations-shared-rows) plus
  `kind: "trigger", on, spawn, template?, enabled, triggerApi, scope,
  createdAt, updatedAt`.
  - `id` is always qualified (`local/<id>` or `<member>/<id>`); verbs accept
    `local/<id>` or a bare local id.
  - `on`: `{source: "github.pull_request", repo, events: [opened | reopened |
    ready_for_review | labeled | synchronize], labels, base?, poll}`, or for a
    capability source `{source: "<capability>:<source>", params: {<name>:
    <string>}, events: [<the source's event names>], poll}`.
  - `spawn`: `{soul, purpose, task, teams, launchConfig?, harness?, model?,
    yolo?, backend?}`. `purpose` and `task` template over `{repo}`,
    `{number}`, `{url}`, `{event}`, `{trigger}`, `{headSha}`, `{subject}` and
    `{key}`; a capability source's over `{trigger}`, `{source}`, `{subject}`,
    `{event}`, `{key}`, `{url}` and `{fields.<name>}`. `teams` are
    distinct labels passed as `--provider <messaging cap> join=<labels>`; a
    soul without messaging refuses `E_TRIGGER_TEAMS {soul, teams}`.
  - `template?`: `{package, version, commit, template}`.
  - `lastRun`: `{at, instance, home, event, number, subject, key, warnings?}`
    (`warnings?`, feature `schedule-run-warnings`: the fire's spawn answer's
    warnings, present only when it had some)
    (`subject`, 0.49.0: the event's subject, a PR's number as a string;
    for a run recorded before 0.49.0, its number; a capability source's
    run has `number: null`); `nextDue`: the next poll here, `null` before
    the first.
  - `invalid?`: `{code, message, field?}` when the stored definition no
    longer validates, as before. A capability source's trigger whose last
    meaning check failed at a poll carries `invalid: {code, message, field?,
    at}` instead (`code` `E_TRIGGER_SOURCE` or `E_TRIGGER_INVALID`; `at` when
    the check ran), until a good poll. `invalid` always means the trigger
    itself is invalid; an event the source answered badly is an *invalid
    event* (`invalidEvents`).
- `status [<id>]` → `{triggerApi, scope, triggers: [{id, name, enabled,
  runsHere, reason, enabledHere, repo, soul, concurrency: {max, perKey},
  liveCount, live: [{instance, home, repo, number, subject, event}], lastPoll:
  {at, ok: true, prs, matching} | {at, ok: false, error} | null, nextPollAt,
  nextDue, pending: [{key, event, number, subject, url, observedAt}], fired:
  [{key, at, instance, home, event, number, subject}] (newest 50), firedTotal,
  lastError: {at, code, message, key?} | null}]}`. It writes nothing.
  `subject` (0.49.0) is the event's subject, the thing `perKey` counts: a
  PR's number, as a string. A record written before 0.49.0 has none, and
  its number is reported.
- **A capability source's `status` row** (feature `trigger-sources`) has
  `repo: null`, `number: null` in `pending[]`, `fired[]` and `live[]`, and
  adds `source: {capability, name}`, `invalidEvents: [{text, rule}]` (the
  last good poll's, at most 20; `rule` is `shape`, `unknown-key`, `key`,
  `subject`, `event`, `url`, `fields` or `duplicate-key`, `text` the first
  200 characters of the event's JSON), `skipped: [{subject, why}]` (the last
  good poll's, at most 100) and, when its last meaning check failed,
  `invalid: {code, message, field?, at}`. Its `lastPoll` is `{at, ok: true,
  events, invalidEvents, skipped, filtered}` (counts) or `{at, ok: false,
  cause, error, source?}`, and `lastError` may carry the same `source`.
  `cause` is `exit`, `result`, `too-many-events`, `timeout`, `refused` or
  `resolution`; `source: {code, message?}` is the source's own refusal.
  `why`, `source.code` and `source.message` are the source's untrusted text,
  capped (200, 128, 500 characters) with control, separator, bidi,
  invisible and tag characters replaced by U+FFFD: render them as text,
  marked as the source's.
  - **Presence and staleness.** `source`, `invalidEvents` and `skipped` are
    always present on a capability source's status row. The two lists are
    `[]` until the trigger's first good poll and hold the last good poll's
    lists after that. A failed poll (`lastPoll.ok: false`) and a failed
    meaning check (`invalid`, which leaves `lastPoll` as it was) leave them
    unchanged, so they can be older than `lastPoll.at`, `lastError.at` and
    `invalid.at`. The lists are the current source's: changing a trigger's
    `on.source` empties them and `pending`, and clears `invalid`, `lastPoll`
    and `lastError` (`fired` stays), in what `status` and `list` answer at
    once and in the state at the next tick.
  - **Arrays versus counts.** In `trigger test`'s `source` (`ok: true`) and
    in `trigger poll`'s answer, `events`, `invalidEvents` and `skipped` are
    arrays and `filtered` is a count. In `lastPoll` (`ok: true`) and in the
    tick's `polled` row, all four are counts.
- `test <id>` → `{triggerApi, id, ok, placement: {runsOn, owner, host,
  runsHere, reason, detail?, enabledHere}, gh: {ok, account,
  credentialSource, reachesHostTimer, note, detail}, repo: {key, readable,
  fullName, permissions: {push, maintain, admin}, canMerge} | {key, readable:
  false, error}, soul: {resolves, name, agent, messaging} | {resolves: false,
  name, error}, teams: {requested, undeclared | null, messaging}, wouldFire:
  [{key, repo, number, subject, event, url, instance, nameCut, held?}],
  pollError?, problems, warnings, spawned: false}`. `ok` counts `problems`
  only; a credential the host timer cannot reach is a warning. `instance`
  and `nameCut` (0.49.0) are the name the spawn would be asked to derive
  (`<stem>-<purpose as passed>`, before spawn's `-<n>`) and whether its
  purpose was cut to fit ([schedules.md](schedules.md#triggers)); both are
  `null` when the soul does not resolve or its name is too long for a
  triggered spawn (that error is then in `problems`).
- **`test <id> --run-source` of a capability source's trigger** runs the
  source (it executes the capability's source command, whatever the host's
  trust and `runsOn` say, and so only with the flag: see **`--run-source`**
  below) and answers `{triggerApi, id, ok, placement, gh, repo: null,
  soul, teams, source, wouldFire, problems, warnings, spawned: false}`, no
  `pollError`. `gh` is `null` unless the trigger has an `owner` (then as
  above, for the owner's host). `source` is `{capability, name, ok: true,
  events, invalidEvents, skipped, filtered}`, `{capability, name, ok: false,
  filtered: 0, invalid: {code, message, field?, at}, events: [],
  invalidEvents: [], skipped: []}` when its meaning fails, or `{capability,
  name, ok: false, filtered: 0, cause, error: {code, message}, source?,
  events: [], invalidEvents: [], skipped: []}` when the poll fails.
  Without `--run-source`, `test` answers a trigger whose meaning or
  resolution fails as above (exit 0, `source.ok: false`: no capability code
  runs to say so), and a trigger whose meaning holds with
  `E_TRIGGER_SOURCE_RUN`. `wouldFire` rows are `{key, subject,
  event, url?, instance, nameCut, held?}`. When the tick would not run the
  trigger here, `problems` holds `run manually with --run-source; the tick
  will not run it here: <reason>` (with the placement's detail). `warnings` always holds
  "this source's credential may not be visible to the host timer: it runs
  with only PATH and OATS_HOME_DIR set, so keep the source's login in its
  own store, not in an exported variable".
- **`poll <id> --run-source`** (feature `trigger-sources`) runs a capability
  source's trigger's source once, its meaning checked first, and answers
  `{triggerApi, id, source: {capability, name}, events: [{key, subject,
  event, url?, fields}], invalidEvents: [{text, rule}], skipped: [{subject,
  why}], filtered}`, plus `observation` with `--max-age`. `events` are the
  valid events the trigger selects, `key` as the source wrote it (stored
  prefixed `<trigger>:`); `filtered` counts the valid events whose `event`
  the trigger does not select. It records nothing and spawns nothing, but it
  executes the capability's source command. A failed poll is `E_TRIGGER_POLL`
  with `details: {cause, source?}`; a meaning failure is `E_TRIGGER_SOURCE`
  `{capability, source, pointer?}` or `E_TRIGGER_INVALID {field}`; without
  the flag it is `E_TRIGGER_SOURCE_RUN`; a `github.pull_request` trigger is
  `E_BAD_ARGS`, with or without the flag. Without `--max-age` it observes
  the members live.
- **`--run-source`** (feature `trigger-sources`): by hand, `test` and `poll`
  run a capability source's command only with this switch (it takes no
  value). It is caller intent, never trust consent: with it they run the
  source whatever the host's `automations.trust` and the trigger's `runsOn`
  say, and trust, `runsOn` and `owner` gate the tick exactly as before (the
  tick passes the flag to its own child). Without it, on a capability
  source's trigger: `E_TRIGGER_SOURCE_RUN`, `ok: false`, a non-zero exit,
  `details: {capability, source, flag: "--run-source"}`, and a message
  naming the command to run again (`oats trigger test|poll <id>
  --run-source`), and the trigger's `runsOn` when that is another host: it
  holds only the id, the capability and source names and `runsOn`, never
  text of the source's. Nothing of the capability has executed and nothing
  has been written in the deployment, the soul's copy under `agents/` and
  the capability's directory in the module store included. The
  order is fixed: a valid definition (`E_TRIGGER_INVALID`), then its meaning
  and the soul's resolution (`E_TRIGGER_SOURCE`, `E_TRIGGER_INVALID
  {field}`, `E_TRIGGER_POLL` `cause: "resolution"`), then this gate, then
  the run. On a `github.pull_request` trigger the flag is accepted and
  inert: `test` answers byte for byte the same.
- **What a `triggerApi: 1` reader sees.** `triggerApi` stays 1. `on.source`
  is an open string: tell rows apart by it, and gate on `trigger-sources`.
  The keys above (`source`, `invalidEvents`, `skipped`, a meaning failure's
  `invalid`, `test`'s `source`) appear only on capability-source rows and
  are absent, not `null`, on a `github.pull_request` row, whose outputs are
  exactly as before. On a capability source's rows the PR-only fields are
  `null` (`repo`, `number`) or absent (`on.repo`, `on.labels`, `on.base`,
  `wouldFire[].repo`), and `lastPoll` carries the counts above instead of
  `prs` and `matching`.
- A triggered instance records `instance.json.trigger`: `{id, key, source,
  repo, number, subject, url, event, headSha, observedAt, eventFile}`
  (`subject` since 0.49.0; `null` when the event had none). Its event file is
  `OATS_TRIGGER_EVENT_FILE`: `{trigger, source, repo, number, subject, url,
  event, headSha, labels, observedAt, key}`. For a capability source the
  record has `repo: null`, `number: null`, `headSha: null` and adds `fields`,
  and the event file is `{trigger, source, subject, event, key, url?,
  fields, observedAt}`.
- `update <id> --description=<text>` (feature `automation-descriptions`)
  changes only a local trigger's description; `--description=` (empty)
  removes it. It sets `updatedAt` and leaves fired and pending events
  untouched. `<id>` is `local/<id>` or the bare id; a workspace trigger
  refuses `E_AUTOMATION_WORKSPACE`. Any other flag is `E_BAD_ARGS` ("only
  --description is supported for now"). An older kernel has no `update`.
- `add` of a capability source's trigger checks its meaning against the
  soul's resolution before anything is written (`E_TRIGGER_SOURCE`,
  `E_TRIGGER_INVALID {field}`, or the soul's own resolution error).
- Errors: `E_TRIGGER_INVALID {field}`, `E_TRIGGER_EXISTS`,
  `E_TRIGGER_UNKNOWN`, `E_TRIGGER_TEAMS`, `E_TRIGGER_SOURCE {capability,
  source, pointer?}` (a capability source that is undeclared or malformed,
  whose capability the soul does not compose, or whose command is not a file
  inside the capability; `pointer` is a JSON pointer into the manifest),
  `E_TRIGGER_POLL` (`details.cause` and `details.source` for a capability
  source), `E_TRIGGER_SOURCE_RUN {capability, source, flag}` (`test` or
  `poll` of a capability source's trigger without `--run-source`: nothing
  ran, nothing was written), `E_TRIGGER_FAILED`, `E_BAD_ARGS`, `E_PACKAGE_MISSING`,
  `E_PACKAGE_MANIFEST`, `E_LOCAL_MISSING`.

<a id="automations-shared-rows"></a>
### Shared row fields and workspace automations

Details: [schedules.md](schedules.md#workspace-triggers-and-schedules).

**Both lists** carry `host: {name | null, ghUser: {<gh host>: <login> |
null}}` (this machine's `host.name` and its `gh` logins, compared with a
row's `owner`), `snapshot: {takenAt, problems (a count)} | null` (the last
`oats sync` snapshot), and `scheduler: {installed, active, registered,
problems, lastTick, maxConcurrent, triggersMaxConcurrent, …}` (nothing runs unless installed, active and
registered; `problems` is always an array of `{code, message, fix}` warnings
about the installed unit, see [schedules](schedules.md#the-host-timers-unit), and never
changes `installed` or `active`). `maxConcurrent` is the effective scheduled-job cap (default 5);
`triggersMaxConcurrent` is the separate trigger cap, or `null` for no host cap.

**Every row** carries:
- `id` (a local schedule keeps its bare id; a workspace item is
  `<member>/<id>`), `qualifiedId` (always qualified), `name` (the bare id).
- `origin`: `{kind: "local", path: "oats-schedules.json", url: null,
  localPath}` or `{kind: "workspace", repoKey, path, commit, url,
  localPath}` (`url` for `github.com` only; `localPath` `null` when the
  member is not cloned here).
- `description`: what it is for, in words, or `null`. One rule for both kinds
  and every level: one line of 1 to 200 characters with no control
  characters (no `\p{Cc}`, U+2028 or U+2029). A local item's comes from its
  definition; a workspace item's from its file header, and for a trigger made
  `from:` a package template, the template's when the header has none. A
  header out of the rule counts as none (the item still runs) and leaves a
  snapshot problem at `<path>#/description`. Like `task`, it is untrusted
  text: render it as text. A kernel before 0.43.0 (feature
  `automation-descriptions`) sends `null` for every local trigger and refuses
  a trigger `description`; one before 0.40.0 sends `null` for every local
  schedule too.
- `owner`, `runsOn`, `runsHere`, `reason` (`null` |
  `host-unnamed` | `assigned-elsewhere` | `owner-mismatch` | `untrusted`),
  `reasonDetail`, `enabledHere`.
- `untrusted` (0.30, [automations.trust](configuration.md#who-runs-workspace-automations)):
  placed on this host (`runsOn` and `owner` match) but `oats-local.yaml`
  `automations.trust` does not admit it, so it never runs here. Its
  `reasonDetail` names the line to add. Group it as needing attention, like
  `owner-mismatch`. A kernel before 0.30 never sends it; treat an unknown
  reason as "does not run here".
- `soul: {name, origin} | null` (`null` for command, wake and operation
  schedules). `origin` is `{kind: "member", repoKey, member}`, `{kind:
  "package", package, version}`, `{kind: "external", repoKey, source}`,
  `{kind: "ambiguous", candidates (a count)}`, or `null`.
- `task`, `teams`, `launchConfig`, `harness`, `model`, `concurrency`,
  `lastRun`, `nextDue`, `invalid?`. A schedule row's `kind` is its run
  (`spawn | command | wake | operation`), its `teams` is `[]` and
  `concurrency` `null`. A workspace item another host runs carries its
  definition and placement only.

**Workspace items:**
- `enable`/`disable` edit `oats-local.yaml` `triggers.disabled` or
  `schedules.disabled`: that list and no other entry, under
  `<deployment>/.agents/locks/local.lock` and from the file as it is under
  it, as [`oats teams`](#oats-teams) writes that file. A lock still held
  after 5 s is `E_LOCAL_BUSY {path, lock}`, and a file that kept changing
  while the edit ran is `E_LOCAL_CHANGED {path}`; nothing was written, and
  the same command can be run again. `update` and `remove` refuse
  `E_AUTOMATION_WORKSPACE {id, origin}`. `schedule run`/`reconcile` elsewhere refuse
  `E_AUTOMATION_NOT_HERE {id, reason, runsOn, owner}`.
- `oats trigger|schedule add … --workspace <member> --runs-on <host> --owner
  <host>/<login> --json` writes the file in the member clone and answers
  `{id, written, file: {member, repoKey, path, content, written?}}`. Errors:
  `E_AUTOMATION_MEMBER`, `E_TRIGGER_EXISTS`/`E_SCHEDULE_EXISTS`, and the
  kind's validation codes.
- `oats automations refresh --json` → `{automationsApi, snapshot (the file's
  path), triggers, schedules (counts), problems, takenAt}`.
- The tick's `considered[]` holds schedule rows and trigger rows `{workspace,
  trigger, action, …}` with actions `not-due`, `poll-failed`, `polled`
  (`prs`, `matching`), `held`, `fired` (`key`, `instance`, `home`),
  `spawn-failed` (`key`, `code`, `error`), `would-fire` (`key`, `event`,
  `number`, `subject`, `url`, `instance`, `nameCut`; a dry run previews the
  soul as a tick does, and reports a preview failure or a name that cannot
  fit as `spawn-failed`), `invalid` and
  `not-here`. A capability source's trigger adds `poll-deferred`
  (`deadline`: its poll could not end by 50 s after the tick started; it
  goes first next tick), its `polled` carries `events`, `invalidEvents`,
  `skipped` and `filtered`, `poll-failed` a `cause`, `invalid` a failed
  meaning check, and its `would-fire` has no `number`, and no `url` when the
  event has none. A workspace schedule's state key is `<member>~<id>`. A failed
  snapshot refresh is `{workspace, action: "error", error}`.

<a id="the-harness-rename-feature-harness-oats-0270"></a>
## Harness input spellings

What starts an instance (pi, claude or codex) is its **harness** (feature
`harness`), and every output uses that name. These inputs still accept the
older `runtime` spelling: it is read as `harness`, and the next write records
`harness`. A pair that disagrees is refused.

| Input | Old spelling | Warning | Both, disagreeing |
|---|---|---|---|
| `spawn` (and `--preview`), `session start`/`restart`, `launch-config preview`, and their `--server` forms | `--runtime <h>` | yes | `E_BAD_ARGS` |
| `oats-local.yaml` `launch-configs.<name>` | `runtime:` | yes | `E_WORKSPACE_SCHEMA` (`reason: "harness-conflict"`) |
| `launch-config set --file` | `runtime` | yes; written as `harness` | `E_LAUNCH_CONFIG_INVALID` |
| a home's `instance.json` and launch recipe `version: 1` | `runtime` | yes, naming the home; the next start records `harness` | |
| schedule definitions (`add`/`update`, stored jobs) | `runtime` | yes | `E_SCHEDULE_INVALID` |
| schedule run records | `startedRuntime` | no | |
| a flat soul.yaml (a capability-defined agent) | `runtime:` | no | `E_BAD_MANIFEST` |
| a manifest `requires[]` harness-package row | `runtime` | no | a spawn problem |

One warning per command, however many old spellings it read:

```json
{"code":"deprecated-runtime-name","key":"runtime","replacement":"harness","sources":["the --runtime flag (use --harness)"],"message":"`runtime` was renamed to `harness` in 0.27.0; the old name is still read here (the --runtime flag (use --harness)) and a later release drops it"}
```

The `--server` routes translate for a host without the `harness` feature:
they send `--runtime` and `runtime` keys and read its `runtimes` list.

<a id="harness-token"></a>
### `harness token`

`oats harness token set|status|remove <harness> --server <id> [--name <team>] [--stdin] [--debug] --json`
runs on the operator's machine. Its `--server` selects that registration's
separate operator route, never a remote invocation of this CLI. The harness
is `claude`, `codex`, `pi` or `opencode`; the name defaults to a valid
server label and otherwise is required. The ordinary schemaVersion 1 envelope's
result is:

```json
{"server":"build","action":"status","harness":"claude","name":"team","fingerprint":"sha256:0123456789abcdef","replacedAt":"2026-11-10T00:00:00Z","warnings":[]}
```

For `remove`, `action` is `remove` and `fingerprint` is `null`.
`set --stdin` returns `action: "set"` and also `staleInstances`, an array
of `{instance, agent, home, startedAt}` from that server's status rows, with
the same harness and a last-start time before or during the second named by
`replacedAt`. The receiver records whole seconds, so starts during that second
are included conservatively: they may still use the previous credential. If
that roster cannot be read, `staleInstances` is `null` and `warnings` holds
a plain explanation; the installation remains successful. No automatic
restart is performed. Only `set` accepts stdin, as bounded credential bytes;
there is no credential argument, result field, event or file on the client.
The receiver's single JSON line and exit status must agree, name the requested
harness and team, and carry valid metadata. Malformed or oversized replies fail
closed as unexpected replies. Text-mode refusal messages escape remote control
characters for the terminal. C0 controls and DEL in refusal reasons become
spaces in both modes; JSON retains the remaining characters without terminal escaping.
The submitted credential is redacted in both modes.
Refusals: `E_BAD_ARGS` for unsupported arguments or names,
`E_SERVER_UNKNOWN` for a server id without a registration, even with an orphan operator route,
`E_HARNESS_TOKEN_ROUTE` for a missing operator alias,
`E_HARNESS_TOKEN_INPUT` for invalid, too-large or terminal stdin,
`E_HARNESS_TOKEN_UNSUPPORTED` for unavailable interactive capture or a
refreshing sign-in, and
`E_HARNESS_TOKEN_DELIVERY` for connection failure, receiver refusal or an
unexpected reply. Public errors do not forward raw SSH or malformed receiver
output. `--debug` adds transport facts on stderr, never stdin or raw receiver
output that might echo it. See [servers](servers.md#harness-credentials).

### `harness trust`

`oats harness trust [--dir <deployment>] [--harness claude|codex|all] [--plan] [--json]`
is host-local. Bare applies; `--apply`, remote selectors, unsupported harnesses,
unknown flags and extra positionals are `E_BAD_ARGS`. Default harness is `all`.
It uses the existing success/error JSON envelope. Result:

```json
{
  "operation": "harness-trust",
  "mode": "plan",
  "root": "/canonical/deployment",
  "entries": [{
    "harness": "claude", "file": "/native/.claude.json",
    "ambient": true, "launchConfigs": [],
    "key": ["projects", "/canonical/deployment", "hasTrustDialogAccepted"],
    "current": null, "desired": true,
    "beforeDigest": null, "afterDigest": "sha256-hex", "status": "change"
  }],
  "audit": null,
  "warnings": []
}
```

There is one entry per target file: the ambient file of each selected harness,
then one per launch configuration whose `env` sets `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`, or sets `HOME` when its launch has no such variable at all
(its default file under that `HOME`), deduplicated by canonical directory. `ambient` says whether the
file is the one a launch with no launch configuration reads (by the
environment its tmux pane will have, or the operator's own when no OATS tmux
server runs, which `warnings` then says:
[harness-trust.md](harness-trust.md)); `launchConfigs` names the launch
configurations that select it (sorted). A launch configuration whose directory cannot
be resolved (an unset reference, a relative path) or does not exist is a
`refused` entry with a `problem` string naming it; `file` is null when the path
is unresolved. The directory is never created. A file the writer refuses (its
type, links, owner, mode bits, `ls` metadata markers, size, encoding or format)
is a `refused` entry whose `problem` is the file and the check that refused it,
in fixed wording that never includes the file's content; such an entry's
`current` and digests do not describe the file's trust.

Entry statuses are `change|unchanged|refused|applied|failed|incomplete|not-attempted|skipped`. `skipped` (with `reason`) is a harness whose ambient configuration directory does not exist under `--harness all`; it is never created.
`current` contains only the known trust scalar, or null when missing. Codex's key
ends in `trust_level` and its desired value is `trusted`. Digests are raw-byte
SHA256 hex; missing files have null beforeDigest. Plan and unattempted entries
carry the candidate afterDigest. Failed/incomplete attempted entries carry the
last observed digest, or null for an absent/unverifiable file (a warning marks
unverifiable observations). The intent retains the candidate digest. Apply's audit is
`{path,operationId,status:"recorded"|"incomplete"}`. Override provenance is conveyed
in warnings, without native configuration contents.

Preflight failures, including any entry `problem`, use `E_CONFIG_BROKEN` with the
result in details; the message names each problem. One case has its own code:
when the only refused entries are ambient ones whose file could not be
established, because a server runs and the environment of its panes cannot be
read, or because tmux could not say whether the server runs (its
`list-sessions` refused or cut off; with no tmux on the command's `PATH`
no read is made, and the operator's own file is the target, said in
`warnings`), the code is `E_RUNTIME_ENDPOINT_UNKNOWN` (`Harness trust targets cannot be
established; nothing was written: …`), with the same details: the entry is
`refused`, `file` null, with its `problem`. With a refused launch
configuration's entry beside it, `E_CONFIG_BROKEN` wins. Apply failures
use `E_HARNESS_TRUST_INCOMPLETE`, details `{...result,reason,mayHaveChanged}`;
reason is the closed set `locked|changed|audit|write|verify`; the message names the
failed files. Partial writes are
retained. No existing instance-event envelope or lifecycle DTO changes.

Audit JSONL rows have `version: 1`, `kind: "harness-trust"`, ISO `at`,
`operationId`, `phase: "intent"|"outcome"`, harness, root, file, beforeDigest,
afterDigest and status.
Intent status is planned; outcome status is applied, unchanged, failed or
incomplete. See [native trust](harness-trust.md) for durability and race limits.
