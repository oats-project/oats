# Desktop deployment model on kernel JSON (Phase F, F1)

The Desktop is built for workspace model v2. Every fact it shows about a local
deployment comes from the installed kernel's JSON; the Desktop reads no
deployment file (`oats-local.yaml`, `oats-workspace.yaml`, member souls,
manifests or locks) and keeps no fallback reader for older kernels.

## Reads

For each registered deployment directory `D`, the server
(`packages/client/deployment-observer.mjs`) performs two fixed-argv reads with
the accepted CLI, `cwd = D`, no shell, a 30 s timeout and a 4 MiB output
bound (`packages/client/deployment-read-cli.mjs`); when the probe declares `observe-max-age`
they carry `--max-age <seconds>` (see
[desktop-load-path.md](desktop-load-path.md)):

- `oats status --dir D --json` — the roster. A raw `{root, agents, workspace}`
  object. Instance rows carry `modules[]` drift (or the recorded map when the
  workspace is unreachable), `soul` source, and `identity` only when a
  provider reported one. Its `workspace` object also carries the
  deployment's workspace identity (feature `workspace-identity`), kept as
  reported for [workspace views](#workspace-views-and-deployments).
- `oats workspace status --dir D --json` — the workspace header: a
  `schemaVersion: 1` envelope with `workspaceStatusApi: 1`: workspace name,
  key and commit, members, packages and `unsynced`/`stale`. There is no
  package approval (kernel feature `packages-no-approval`): declaring a
  package in `packages:` is the trust decision.

A nonzero exit is never success, even with plausible stdout. A kernel refusal
keeps only its bounded `code`/`message`, and the reader marks it `origin:
'kernel'` (`packages/client/deployment-read-cli.mjs`): the error is the one
the installed CLI printed in its envelope. A failure the reader made itself
(no accepted CLI, a missing feature, bad arguments, a timeout, the output
limit, an answer that is not the contract's, a failed run) carries no origin.
The mark travels with the reason, whole, through the observer, the entry of
an unavailable deployment and `/api/panel` to the page.

A deployment that is not observed says why in one sentence
(`packages/client/deployment-facts.mjs`):

| The reason | The sentence |
|---|---|
| the kernel's (`origin: 'kernel'`), a message | `OATS answered with an error (<code>). It says: <message>` |
| the kernel's, a message the display filter withholds | `OATS answered with an error (<code>). [withheld]` |
| the kernel's, no message to show | `OATS answered with an error (<code>).` |
| the reader's own (no origin) | `<code>: <message>`, the reader's fixed sentence |
| a missing feature | the feature and the client that needs it |
| not read yet | "Reading the deployment through the installed OATS CLI…" |

The kernel's message is shown through the display filter
(`display-text.mjs`): one line, whole or withheld, never cut by its words,
parsed or matched. A reason is the kernel's by its mark and a code the reader
admits, never by the shape of a code alone. `deploymentUnavailableParts`
answers the same sentence as three parts, `headline`, `lead` and `sentence`;
`sentence` is the only one that can carry words the client did not write.
The other texts a client shows that it did not write (a row's
`runtimeError`, the message a deployment keeps beside its last observation
when its re-read failed, the roster's own failure notice) say who made them
too: [Who made a shown text](#who-made-a-shown-text).

Ambient instance/deployment selectors
(`PI_AGENTS_ROOT`, `OATS_INSTANCE_HOME`, `OATS_DEPLOYMENT`, …) are removed from
the child environment.

## Who made a shown text

Three texts a client shows can hold words it did not write: a row's
`runtimeError`, a reason's `sentence` when it is that text, and the message a
deployment keeps beside its last observation when its re-read failed. Each
says who made it, in a key the shared home writes beside the text
(`packages/client/`):

| The text | The key | Written by |
|---|---|---|
| a row's `runtimeError` | `runtimeErrorOrigin` on the row | `deployment-panel.mjs` (`livenessAnswers`, `panelInstances`) for this computer's rows, `remote-roster.mjs` (`remotePanel`) for another machine's |
| a reason's `sentence` | `origin` on the reason | `remote-address.mjs` (`rowReason`), passed on by `instance-acts.mjs` (`instanceActs`) |
| a kept failure's `error` | `errorOrigin` on the entry and the panel | `deployment-panel.mjs` (`failedEntry`), served by `panel-views.mjs` |

**The marks are never taken from an answer.** Only the shared home writes
them, in the client's own process, from the path the text took: a key that
arrives in a kernel's answer, a host's row, another machine's panel or the
liveness collector's output is set again or removed on every path. No code
and no message is read to decide one. **A text with no origin is shown as
before, with no speaker in front, and never under "OATS says:".**

A reason's `origin` also says whose sentence it is: **it is there exactly
when the sentence is not the shared home's own.** `rowReason` puts a row's
`runtimeError` in a reason in one expression, which answers the text and
its `origin` together, so no path picks the row's text without one. A
client hangs its display filter on the key: a sentence with an `origin` is
text from outside, and a sentence with none is one the shared home wrote
(the row is "not reached", its state is unknown, the stand-in for an older
kernel's Herdr row) and is shown as written.

### The speakers and their words

A client puts the speaker's words in front of the text, on the same line.
These are all the speaker phrases a client shows; another is added here or
nowhere.

| The speaker | The key's value | The words |
|---|---|---|
| OATS: this computer's, or a host's relayed by it | `kernel` | `OATS says:` |
| the client's check of this computer's terminals | `terminal-probe` | `Desktop's terminal check says:` |
| the client's read of the other machines' roster | `roster-read` | `Desktop's read of other machines says:` |
| OATS, refusing to read a deployment (a reason marked `origin: 'kernel'`, above) | | `OATS answered with an error (<code>). It says:` |
| nobody: a row's text that reached `rowReason` beside no speaker | `unattributed`, on a reason's `origin` only | none: the text alone |

The first three are `originLead(origin, terms)`
(`instance-presentation.mjs`), which answers `null` for any other value; the
client's name in them is its own term (`terms.name`). `kernel` covers this
computer's OATS (it could not reach a server, and said why) and another
host's OATS whose row this computer's OATS relayed; the row's
`serverUnreached` says which read it is.

`unattributed` stands for a text nobody attributed, and has no phrase. Every
text a row carries gets a speaker where the panel is made, so the value is
reached only by a row whose mark did not arrive with it, and by a
`runtimeError` that is not a string (another machine's row is spread whole).
`rowReason` writes it and nothing else does: it is never read from a row or
an answer, never a row's `runtimeErrorOrigin` and never a kept failure's
`errorOrigin`. Such a text is shown through the display filter, with no
speaker in front; one that is not a string has nothing to show, and the row
keeps its label.

### Which text gets which

| Where the text is chosen | `runtimeErrorOrigin` |
|---|---|
| a row the kernel answered `running: null`, left as it is | `kernel` |
| a row whose session backend OATS no longer has, with the kernel's own reason (`runtimeState: "unsupported"` and a `runtimeError`) | `kernel` |
| another machine's row, its server reached: the host's own text | `kernel` |
| another machine's row, its server not reached, by an error the installed CLI printed | `kernel` |
| the kernel's text that a terminal check's answer leaves on the row | `kernel` |
| the terminal check: its own sentences, the message of a failed `tmux` or `ps` run, "Invalid terminal target", "Terminal status is unavailable" | `terminal-probe` |
| another machine's row, its server not reached, by an error the client wrote while reading the roster ("Server is unreachable", "Remote roster unavailable", a timeout, an answer that is not the contract's) | `roster-read` |
| the stand-in written for an older kernel's Herdr row (`E_HERDR_REMOVED: …`) | none: it is the client's own sentence |

A row without a `runtimeError` (a non-empty string) never has the key. An
error the installed CLI printed is known by a mark set where its answer is
parsed (`cli-adapter.mjs`, `kernel-made.mjs`), on the object and not in its
fields: it cannot arrive in an answer, and a copy of the error loses it and
then reads as the client's own, never as the kernel's.

### How the Desktop shows them

One helper makes the line for every place (`renderer/speaker-line.mjs`): the
speaker's words, a space, and the text as one display line
(`display-text.mjs`). Every text the shared home did not write goes through
that filter: a row's `runtimeError`, a kept failure's message, and a
reason's sentence when the reason carries an `origin`. A text of several
lines is shown as one; a text the filter withholds (control characters, a
credential's shape) reads "[withheld]" alone, with no speaker in
front; a text with nothing to show leaves the place saying what it said
before for a row without one. The places: a roster row's title and
description and its hover card's Status, the row's context menu (what it
says when it is held, Start's reason, Open in split's reason), the notice of a terminal that
cannot open, the start dialog's status, the context panel's Start, the
overview's Go to instance and Start…, the roster's failure notice and the
overview's.

### A kept failure

A deployment whose re-read failed and whose last observation is kept holds
the failure's message as `error`, always a string: the message, or `""`
when the failure had none. **That `error` is a string is the fact "a failure
is kept"; what it holds decides nothing** (`deployment-facts.mjs`
`keptFailure`, the one place that reads it). So a failure with no message, a
blank one or one the filter withholds leaves the deployment `stale` like any
other, and the shared reason and each of the Desktop's notices agree.
`errorOrigin` is `"kernel"` when the installed CLI printed the message and
absent otherwise; another machine's panel never carries it.

The reason of a stale deployment is under "Reasons". The overview's notes
of a kept failure have the same shape, composed in one place
(`keptFailureNote`, `renderer/views/hierarchy.mjs`): "Roster unavailable.
Showing a reported observation, not current state; actions disabled. OATS
says: <message>" for the kernel's message, the Desktop's sentences alone
when there is none to show, and "Roster unavailable: <message>. Showing…"
for a message with no speaker (another machine's panel). A failed read that
kept no rows reads the same way around the sentence for what is on screen:
"Roster unavailable. No current observation. OATS says: <message>".

## Capability gates

Reads are gated on the accepted probe (`oats version --json`), never on a
version number: `workspaceApi === 2`, `workspace-v2` and
`packages-no-approval` for the header, plus `instance-modules` and
`served-identity` for the roster. A missing feature is
shown by name in the header and roster; nothing is invoked optimistically.
A deployment whose read is refused for a missing feature is unavailable: it
lists no instance and no soul, so nothing can be spawned in it until OATS is
updated.
Matching deployments into workspace views needs `workspace-identity`; without
it each deployment keeps a view of its own under its deployment id, the switcher
lists them as before (not under "Not matched to a workspace"), and the
deployment list says why.
`ACCEPT_RANGE` is the floor, `>=0.26.0`, and the tested bound is this Desktop's own
minor, read from its manifest (`testedBound`, `packages/client/cli-locator.mjs`). The floor is the first kernel the
feature gates above let through (a 0.25 kernel is refused by the locator and
meets the "Compatible `oats` CLI required" card), and the minors tested so far are 0.27 (the harness rename, gated on feature
`harness`) through 0.30 (team model v2, gated on feature `team-model-2`; the
0.29 team shapes are still read), 0.31 (Herdr removed; per-instance reads and
plans routed by `--server`/`--home`, gated on the probe's `remote` entries),
0.32, 0.33 (spawn preview `--max-age`, feature `spawn-preview-max-age`), 0.34
(`capabilities show`, feature `capability-show`), 0.35 (`capture --file`,
feature `capture-file`), 0.36 (workspace identity on `status`, feature
`workspace-identity`), 0.37 (launch preview, no new feature), 0.38 (team
model 3, feature `team-model-3`, which replaces `team-model-2`: the team views
are gated on their feature), 0.39 (server connect, the capability route and
servers per workspace, features `server-connect`, `capability-route` and
`servers-per-workspace`), 0.40 (needs input, feature `waiting-on-you`), 0.41
(retirement deletes no branch; `retire --delete-branch` is refused and the
Desktop no longer offers it; new sessions run on the OATS tmux server, named
by the socket each row records), 0.42 (a retire plan carries two recovery
notes and a retire receipt's `workRecovery` adds `home`, `notCopied` and
`afterHooks`, which the lifecycle readers accept), 0.43 (schedule and
trigger rows carry `description`, and `<kind> update <id> --description`
sets one, feature `automation-descriptions`, which gates the summary
writes) and 0.44 (launch-prompt answers: the spawn preview's optional
`launchPromptAnswers`, `E_SPAWN_INCOMPLETE` details' optional `launchPrompts`
and the `launch-prompt` instance event, all read as optional, no new gate; `launchPromptAnswers` and the event's `consentSource` come from 0.44 to 0.51 kernels only), 0.45 (`capabilities` on `oats souls --json` rows, feature `souls-capabilities`, which gates Capabilities' "Used by") and 0.46 (opt-in `oats inspect --soul --instructions` and `composedInstructions`, feature `soul-composed-instructions`, not read by the Desktop yet; no new gate), 0.47 (Desktop lifecycle interaction improvements with unchanged kernel contracts), 0.48 (conditional team default and `--no-default`, feature `teams-conditional-default`, not read by the Desktop yet; no new gate), 0.49 (the `worktree` hook event, feature `worktree-event`, and each host's kernel features on roster groups, feature `server-probe-features`, read where present; capability warnings and the new trigger fields are read as optional; no new gate on the band), 0.50 (capability trigger sources: a trigger test runs a source only with `--run-source`, feature `trigger-sources`, which gates the informed Test; no new gate on the band), 0.51 (one retire of an instance at a time: a second retire answers `E_LIFECYCLE_BUSY`, which the Desktop already words; `--detach-key` on `session attach`, feature `session-attach-detach-key`, not used by the Desktop; no new gate on the band), 0.52 (a stop holds the claim a retire holds, feature `lifecycle-claim-stop`: under it the Desktop reads who holds the claim, `error.details.holder`, on `E_LIFECYCLE_BUSY`; lifecycle answers carry kernel codes only, feature `lifecycle-kernel-codes`: under it a failed row's `stillRunning: []` says the harness exited; the kernel's own answer to Claude's development-channel prompt is read from the data, each field as optional and listed in the next paragraph, while the feature name `launch-prompt-dev-channel` itself is not read and gates nothing; `warnings` on schedule and trigger run records, feature `schedule-run-warnings`, are not read by the Desktop; no new gate on the band), 0.53 (a retire plan says as a fact whether `work/` is the instance's own tree, `facts.ownWorktree`, feature `retire-plan-own-worktree`: under it the key is required in a retire plan and a boolean, and the Retire dialog reads it for whose tree `work/` is, [Whose tree `work/` is](desktop-lifecycle-confirmations.md#whose-tree-work-is); no new gate on the band), 0.54 through 0.58 (no new gate on the band), 0.59 (`retire` on status and remote roster rows, feature `status-retire-state`, read where present; `size` on `session inspect --json`, feature `session-inspect-size`, not read by the Desktop; no new gate on the band), 0.60 (`running` on status rows means the harness is running: a window left at its fallback shell reads `running: false` with `runtimeState: "shell"`, as the Desktop's own terminal probe already reports a local row, and a server's rows now read the same way; no new feature and no new gate on the band), 0.61 (`oats onboard`'s `next.spawn` names the workspace's setup expert, the same text-or-`null` shape; no new gate on the band), 0.62 (capture runs as an OATS-owned periodic service, which the Desktop does not read; `oats session attach`'s viewers clean up after themselves, with the same arguments and exit codes the Desktop's viewer relies on; no new gate on the band), 0.63 (`running` on `session inspect --json`, feature `session-inspect-running`, not read by the Desktop, whose attach preflight reads `present` alone; `details.fields` on `E_RUNTIME_AUTHORITY_MISMATCH`, not read; a bare-harness start's `launched` event records `launchConfig: null`, which the Desktop already reads as no configuration; no new gate on the band), 0.64 (`spawnOrigin` on spawn results and status rows keeps its `instance`/`operator` shape and now names the caller, which the Desktop passes through without reading it; a fallback shell with an empty or `unset` pane command reads `runtimeState: "shell"`, which the Desktop already shows; no new gate on the band), 0.65 (`oats deployments`, feature `deployments-list` with `deploymentsApi: 1`, which the Desktop reads only behind that feature; `listed` on `oats onboard --json`, which the Desktop's onboard reader does not read; a kernel command run in an unlisted deployment lists it, which changes no answer; no new gate), 0.66 (`oats server connect` requires `--dir`, which the Desktop's Add a machine always passes behind feature `server-connect`; the auto-add of the deployments list skips temporary directories and finds a deployment only by a regular `oats-local.yaml`, the rule the list's `ok` already applied, which changes no answer the Desktop reads; no new gate), 0.67 (`color` on status and remote roster rows, feature `instance-color`, read where present and as a palette name only, and `oats instance color`, which the Desktop runs only behind that feature; `composedSkills` on `oats inspect --soul --composed-skills`, feature `soul-composed-skills`, read only behind it; `spawn --preview --suggest-name` and the preview's `naming`, feature `spawn-suggest-name`, used only behind it and `spawn-name`; the spawn preview's capability skill names follow materialize's precedence, which the Desktop does not read; no new gate), 0.68 (`oats instance upgrade`, feature `instance-upgrade`, which the Desktop does not run; its `modules-upgraded` and `upgrade-refused` instance events, which the Desktop titles (the second with its failed `step`, read where present); the optional `previous` on `instance.json` module rows and the optional `drift` on start and restart results, which the Desktop does not read; a claim an upgrade holds refuses a stop or retire with `E_LIFECYCLE_BUSY` and the same `details.holder` states the Desktop reads; `E_UPGRADE_PARTIAL` on a start reaches it as a kernel error with its message; `oats instance suggest-name`, feature `instance-suggest-name`, and `--suggest-name` on a spawn apply, feature `spawn-apply-suggest-name`, each used only behind its feature ([desktop-spawn-preview.md](desktop-spawn-preview.md)); no new gate), 0.69 (`sessionEnd` on status and remote roster rows, kept only as `lost`, `stopped` or `exited`; `oats session resume --json`, feature `session-resume`, which the Desktop runs only behind that feature, detached, when it opens and when a local row reads `lost`, reading `E_RESUME_BUSY` as another sweep running; since 0.69.2 it shows nothing of the answer, and a failed sweep is one log line with its code; from 0.69.2, `background` and `sameWork` on status and remote roster rows, read only behind features `instance-background` and `instance-same-work`, the `oats instance background` verb run only behind the first, the skipped reason `lifecycle-busy`, which the Desktop does not show, and a claim's `action: "resume"`, which it words as any holder of `E_LIFECYCLE_BUSY`; the `@oats-agent` pane option, which the Desktop's tmux status reader follows to the agent's pane, and `paneId` on `oats session inspect --json`, which its review paste targets; no new gate), and the `packages-no-approval` fence is the real
gate.

**Above the tested bound** (#1879): a released CLI of a later minor or major,
with `desktopApi: 1`, is accepted with `aboveTested: true` and `testedThrough`
(`X.Y`) on the probe and on `/api/cli`. Only the operations
`packages/client/above-tested.mjs` names as reads or allowed stay on: the reads,
terminals, the Spawn preview and apply (fenced by `--expect-decision`), Start,
Restart, the colour and the background. Every other operation, one that does not
exist yet included, is refused where it enters the backend, before any CLI process
runs, with code `cli-above-tested` and the notice sentence: each POST handler of
`server/oats-web.mjs` by (route, action), and in main the deployments-list writes,
onboard and the launch resume sweep (skipped with one log line naming the code).
The renderer reads the same table to disable what would be refused, and shows the
notice in the card's place. On the surfaces that stay on, an answer of a shape the
Desktop does not know is an outcome not known, never a success. The card's
"older than the installed CLI" branch is for a newer desktop API only. The
inventory test (`test/above-tested-inventory.test.mjs`) fails for a POST
(route, action) or a CLI-executing module the table does not classify.

The launch-prompt readers also follow the contract of 0.52 (feature
`launch-prompt-dev-channel`: the kernel confirms Claude's development-channel
prompt on every start that passes the flag, with no consent list). Nothing is
gated on that feature and no older reader is removed: each field is read when
the answer carries it, because a routed host can run an older kernel and a home
keeps the rows and outcomes an older kernel recorded. Read from a 0.52 answer:
`differed` on a blocked `launchPrompts` (the details of `E_SPAWN_INCOMPLETE`,
from a spawn or a start); `launchPrompts` with the status `flag-ignored`, and
the `warnings` beside it, on a start's, a restart's or a launched spawn's
successful answer;
`claudeVersion`, `signatureId` and `differed` on a `launch-prompt` event; the
top-level `file` of a `harness-trust` readiness item and the `launch-prompt`
readiness warning; the refusal `E_LAUNCH_CONFIG_AMBIGUOUS`. Read from a 0.53
answer, with no gate: the refusal `E_LAUNCH_PREFERENCE_UNMATCHED` (a key of
`souls.launch` that names no soul), at a spawn's preview, at a press, and as
a soul's launch `problem`; a kernel that does not send it changes nothing on
screen. The pages that own
each are [the spawn dialog](desktop-spawn-preview.md#launch-prompt-diagnostics),
[Activity](desktop-instance-events.md), [Readiness](desktop-readiness.md) and
[the start workflow](../../../docs/desktop-instance-start.md).

## Projection and ownership

`packages/client/deployment-data.mjs` validates and copies each command's own shape once for
rendering; it computes no drift and invents no identity. The roster root must
be `D/agents`, every soul directory must be inside `D`, and the header's
`workspace.local` must be `D/oats-local.yaml`. An instance row whose reported
home is not `<soul dir>/instances/<instance>`, or that repeats another row's
home, is **withheld** and counted in the header — never published, addressed
or silently dropped.

The observer admits at most two deployments at once, and the cycle reads the
registered deployments through a pool of that size (`mapBounded`), first come
first served: every deployment is read each cycle, and a slow one holds one
slot while the others go through the other. The observer reserves its bounded slots synchronously, admits on the current
deployment/CLI revision before each invocation and on completion, releases a
reservation only after both reads settle, coalesces in flight only, and copies
results per waiter. `/api/panel` serves the latest observation and never waits
on a CLI read, so readiness probes stay responsive. The spawn catalog
(`oats souls`) and the capabilities table (`oats capabilities`) are read in the
same cycle but never block the roster; when they run, what is held and when a
cycle runs is [desktop-load-path.md](desktop-load-path.md).

## The open set and adding a workspace

The Desktop keeps two sets, never confused. The **served** set is the list of
deployment directories its app-owned server is started with, one `--dir` each:
only deployments that validate now. The **persisted** open set is
`workspace-open.json` in the app's user data: every saved path, whether or not
it validates at this moment, plus what was opened since. A deployment is a
directory holding a regular (lstat, non-following) `oats-local.yaml`; nothing
else counts (`wsValidate` in `main.mjs`, `validateWorkspace` in
`packages/client/workspace-admission.mjs`).

The persisted set can therefore hold entries that are not served: a deployment
on a volume that is not mounted yet, or a folder that stopped being a
deployment (the Desktop cannot tell the two apart, so it does not guess). Such
an entry is inert: it is never served, never reported as "not served" (that
needs a deployment that validates), and never offered by the switcher. Each
launch re-validates the persisted set, so a deployment that came back is served
again. **Only an explicit remove drops a saved path**; nothing else does. Today
that is the Add dialog's **Remove** on a row of this computer's deployments list
that can't be opened (below); removing a served deployment is #476.

- **Launch.** `restoreWorkspaceDirs` opens the saved deployments plus the
  launch directory (`--dir`, `OATS_DESKTOP_DIR` or the cwd) when that is one. A
  launch from a folder that is not a deployment (a parent folder) opens the
  saved set and logs that it did. A folder that is not a deployment
  is never served, whatever the launch (`/` from Finder included): when nothing
  is a deployment the server starts with no `--dir` (it serves no local
  deployment, never its cwd; main starts it in the first served deployment,
  else the home directory), and the first window is *choosing*.
- **Persisting.** `persistedOpenSet` writes the saved paths as they were, in
  order, then the served deployments they lack, each once. Only deployments are
  ever added to it (`persistableDirs`), so a non-deployment never enters the
  file, and it is never written empty. A launch writes it only when it opened a
  deployment the file lacks (`startupOpenSet`); an add writes it on commit
  (`commitOpenSet`). Neither drops a saved path that does not validate now.
- **Adding.** Every add goes through `createPerformAdd`: `decideAdd`
  (canonical path, provenance, validation), then the transactional executor
  (`createAddExecutor`). The replacement server is started with `stageDirs`:
  the members of the served set that still validate plus the new deployment,
  never a path that does not validate. Only the persisted set never loses an
  entry; a served deployment that went missing during the session is not
  served by the replacement, and stays persisted. Both sets are committed only once the new server
  advertises the deployment, the persisted one first; any failure (a failed
  write included) restarts the previous server and leaves both sets as they
  were. A refusal returns
  before any effect, so the open set and the running server are untouched.
- **Provenance.** `workspace:add` admits only a path the Desktop offered or
  knows: a suggestion, a deployment offered beside a refused pick, or one in
  the session's known set (the saved file as read, the open set, every
  committed add). The native picker (`workspace:pick`) is its own provenance.
  Suggestions are the deployments in the known set that are not served (a
  saved one whose volume was mounted after launch) and the rows of this
  computer's deployments list that are not served (below). A row is a
  suggestion, never authorization: one that can be opened must validate now,
  and the add validates it again. Nothing is scanned to find suggestions.
- **Listing it.** Once an add has committed, `createPerformAdd` runs
  `oats deployments add <path> --via desktop` (`listed`, `listDeployment`), and
  so does startup for the launch's own deployment (`--dir`, or a cwd that is
  one). It waits for the server's CLI probe to settle first (`settledCli`): a
  server just started, by a launch or by an add's replacement, answers its
  routes before its probe settles. A probe that never settles is a failure,
  not a skip. An explicit
  add clears a kernel tombstone, which is intended: the person opened it. The
  restored open set is never listed at startup, or a deployment removed with
  `oats deployments remove` would come back at every launch. Best effort: a
  failure is logged, and an add's answer carries it as `listed: { code,
  message }`, which the window says in a notification once it has switched to
  the workspace. The add is never undone for it.
- **A picked folder that is not a deployment** is refused with "This folder
  isn't an OATS deployment: it has no oats-local.yaml. Choose the deployment
  folder itself, the one that contains oats-local.yaml." `pickedFolderChoices`
  says where the deployment is, without parsing anything: the deployments one
  level down (at most 200 entries read, typed by the entry so links are not
  followed, sorted by name, 20 listed and "and N more"), or the deployment the
  folder is inside (up to 8 levels up). Each choice is one click through the
  normal add. With no choice, onboarding (`oats onboard`, through a
  single-use offer for that exact folder) is the secondary action "Set up a
  new deployment here…", never the default reaction.


## This computer's deployments list

The kernel keeps one list per user of this computer's deployments,
`~/.oats/config/deployments.json` ([#1390](https://github.com/awebai/oats/issues/1390);
the command and its JSON are in [desktop-cli-api.md](../../../docs/desktop-cli-api.md)).
The Desktop never reads the file. Every read and change is a kernel verb, run
from main through the server's accepted CLI (`deploymentList` in `main.mjs`,
`packages/client/deployment-list-cli.mjs`), with fixed argv and gated on the
probe's `deployments-list` feature. The shared reader
(`packages/client/deployment-list.mjs`) turns the answer into rows of
`{ path, name, state }`; a document it cannot read is refused whole.

- **What Add local workspace… shows.** The dialog lists the saved entries
  that are not served and the list's rows that are not served
  (`workspaceSuggestions`), asked of main each time it opens. The sidebar's
  list of workspaces lists none of them: it is the served views alone.
  - A row the kernel calls `ok` is offered only while it validates here too,
    and one click (or Enter) is the normal add.
  - A stale row comes after them, says its state in a word (the sentence is
    its tooltip and what a screen reader hears), and opens nothing. The
    states are `missing` ("Missing: the folder is gone, or its volume isn't
    mounted"), `not-a-deployment` ("Not a deployment any more: no
    oats-local.yaml") and `unreadable` ("Can't be checked: OATS couldn't read
    this folder"). The words are `LISTED_STATE_TEXT` in
    `renderer/workspace-switcher.mjs`.
  - Every stale list row has **Remove** beside it: Right Arrow, then Enter;
    Left Arrow or Escape go back to the row.
- **Without the feature** the dialog offers the saved entries and says "This
  oats can't list this computer's deployments. Update oats." Nothing falls
  back to looking at the disk. A read the kernel refused says "Couldn't read
  this computer's deployments: <the kernel's message>". With no compatible
  CLI the dialog says nothing more: the degradation card covers that.
- **Remove** runs `oats deployments remove <path>` (the kernel keeps a
  tombstone, so nothing adds the row back on its own) and drops the path from
  the saved open set, or the row would still be offered as a saved entry. It
  touches nothing on disk, so it asks nothing; the dialog says what it did and
  drops the row.
  - **Its channel**, `workspace:remove-listed(path)`, is a privileged IPC
    channel with the senderFrame guard (`guard`).
  - **Its provenance** (`createRemoveListed`): only a path that was offered as
    removable to that window in its latest suggestions (`suggestionCalls.removable`).
    A served deployment is refused: removing it is #476.
  - **One queue** (`createSerialQueue`, `servingQueue` in `main.mjs`): adds,
    their listing included, and Removes run one after the other, and a Remove
    checks the offer and what is served when it runs. So another window's add
    of the same deployment either comes first (and the Remove is refused) or
    comes after it (and its listing clears the kernel's tombstone).
- **The one-time import.** At startup, once the server's CLI probe has
  settled, and while `workspace-recents.json` (the recently-added list of
  earlier Desktops) exists, main runs `oats deployments import --from desktop`.
  It names every absolute path of that file and of `workspace-open.json`, as
  written, whatever their state: the kernel canonicalizes them. No path at all
  is still an import, which sets the kernel's marker (`importDesktopLists`).
  An import is never cut: past `DEPLOYMENT_IMPORT_MAX` paths it is refused
  whole and the file is kept. Once the kernel has
  answered, imported now or before, the file is renamed to
  `workspace-recents.imported.json`. A refusal, or a CLI without the feature,
  keeps the file for the next launch. Recents are never read for anything
  else, and never written.
## Workspace views and deployments

A **deployment** is one place a workspace runs: a local deployment directory
the server is started with (its id is the canonical path) or a group of the
kernel's remote roster (id `remote:<server>:<targetKey>`). A **workspace
view** is what the switcher lists and a window shows: every deployment, on
this Mac or on a registered server, that reports the same workspace identity.
Views are built per request from the held observations and the remembered
remote identities, never by a CLI read (`packages/client/workspace-views.mjs` and
`packages/client/panel-views.mjs`, which `server/oats-web.mjs` calls with what it
holds, `held()`).

A matched identity's view id is `ws:` and 20 hex characters of a hash of its
key and default team: never a path, so it cannot collide with a deployment
id. A deployment that cannot be matched is **unattached**: it gets a view of
its own whose id is its deployment id, so a selection saved under that id
still names it.

### The identity

- **Local:** the `workspace` object of the deployment's own `oats status
  --json`, kept by `deployment-data.mjs`, and only when the probe declares
  `workspace-identity`. It is always read fresh.
- **Remote:** the group's `workspace` from `oats server roster --json`,
  verbatim, from a reached group only. `null` means no report; an object with
  no `key` field comes from a host before 0.36.0, which never reports one.

Nothing is derived from a path, a ref or a host name, and a shape the
contract does not allow is not matched.

### Matching

Matching follows the kernel's rules,
[Matching workspaces across machines and Matching teams across machines](../../../docs/desktop-cli-api.md#workspace-identity-feature-workspace-identity-oats-0360).
The outcomes:

- Deployments share a view when each reports `keyFrom: "workspace"`, their
  `key`s are equal and their default teams (`defaultTeam.team`) are equal.
  `ref` is never compared.
- An unmapped default team matches only unmapped.
- Unattached: `keyFrom: "member"`, a `null` key, an unknown team (a `null`
  default team with `standalone: false` and `teamsFrom: "local"`), no report,
  and a host before 0.36.0.
- The same key with another default team is another workspace. Both views'
  names then say which team: its label, else its id, or `unmapped`.

A view is named by its first local deployment's workspace name, else the
key's last segment.

### The primary deployment

A view's **primary** deployment is its first local deployment, else its
first. Deployment-level surfaces read and act on it: the Workspace header and
Setup, Capabilities, Sync, Automations, Schedules, the Teams configuration,
the soul inspector, Brain and launch configurations. The Workspace pages
(the Workspace header and every tab but Machines, the Automations page with
its Schedules, and a capability's, a team's and a soul's page) read it
without naming it (2026-10-23): they send the view id, which
the server answers from the primary, and offer no choice of deployment. In
a view of two or more deployments the side panel's soul inspector says
which under the soul's name ("On This Mac · ~/acme"), as do Brain and the
Sync sheet; a view of one shows no such line. The
Machines tab has no primary: each deployment has its own tab, named
there, and nothing there is marked "primary".

### The panel

`/api/panel?ws=<view id | deployment id>` answers a view. A deployment id
answers the view that holds it; no `?ws=` answers the first view.

- `workspace` is the view (`id`, `name`, `primary`, and `key` and `teamId`
  when it is matched). `primary` is the primary deployment's id: a route that
  echoes the deployment it resolved (readiness, spawn preview) is sent that id,
  never the view id. `deployment`, `error` and the stamps are the primary
  deployment's.
- `workspaces` is the switcher's list of views, each with its `deployments`
  ids, `deploymentLabels`, `machines` (each machine once, in order) and
  `notLive` (how many of its deployments aren't live, stale ones included). The Desktop's list
  shows the name alone, one line, and the needs-input mark (`waiting`): never a machine, a
  path, an id or a reason. Unattached views carry `unattached`, their
  `reason`, `short` and the `ref` they report, and are listed after the
  matched ones in the same list; choosing one opens its tab on the Machines tab
  (`requestDeploymentTab`, `renderer/deployment-tabs.mjs`). Those fields are
  sent only when this computer's CLI has `workspace-identity`: without it
  nothing could be matched, and the entries list as they did before views.
- `deployments` lists every deployment of the view, even a single one:
  `{id, machine, path, label, local, reachable, identityFrom, primary,
  stale?, reason?, short?, fix?, note?}`. `machine` is "This Mac" (the Desktop's label for the
  machine it runs on, `thisMachine` of `renderer/desktop-terms.mjs`) or the server's label, else its
  id. `deploymentLabel` (`packages/client/deployment-label.mjs`) shows it as "This
  Mac · ~/acme" or "altair · ~/northwind": the home directory as
  `~` (on a remote, a `/Users/<name>` or `/home/<name>` prefix, a display
  guess) and the last two segments of a long path. A deployment is live
  (`reachable`), not reached (with its `reason`), remembered
  (`identityFrom: "remembered"`, the last report, not live), or stale
  (`stale`: this computer's deployment whose last re-read failed, its rows
  the last observation, "Last read failed" with the kernel's message after
  the Desktop's own sentence, under "OATS says:"). It is stale because the
  read failed, whatever the message holds: a failure with no message is
  stale too. A
  stale deployment's rows wait for a current read, as on a stale roster:
  Start and the row's context menu in the sidebar, the overview's actions. It stays
  `reachable`, so spawning there is not blocked. `note` is information, not a
  failure.
- `instances` is the union of every deployment's rows, each tagged
  `deployment: {id, machine, path}`. The sidebar's instance list shows a
  heading per deployment (in its group-heading style, named by
  `machineLabels`: the machine, with the path tail when one machine holds two;
  the machine is uppercased, a path tail never is, since a path is
  case-sensitive) only when the view has two or more, and none for a deployment with no rows;
  with one it has no headings. Rows never repeat the workspace name, and a
  row's identity line keeps its host. The tree (the sidebar, the palette,
  the TUI) stands in name order: each cluster by its first root, siblings by
  name, ties by `instanceId` (`instance-tree.mjs` `rosterOrder`, #1262), so a
  start or a stop moves no row. The panel's own list (`panelInstances`) still
  stands running, then unknown (`running` not a boolean), then stopped, by
  name within each: `byRuntimeState`
  (`packages/client/instance-presentation.mjs`).

### A workspace's own machines

The view's key (its primary local deployment's, `keyFrom: "workspace"` only)
also chooses which registered servers the window offers: Where to run, the
Setup tab's Registered machines box and Add a machine list only the registrations that
report that key. See [desktop-machines.md](desktop-machines.md).

### The Machines tab

The Workspace page's **Machines** tab, between Teams and Setup (2026-10-26;
the Deployments page before that, and the Active overview before that: stage
`hierarchy`, Mod+1, which now opens the Workspace page on this tab), shows
the view's overview trees and nothing deployment-specific beyond them. The
page opens on Souls; `views/spawn.mjs` mounts the view (`views/hierarchy.mjs`)
only while the Machines tab is shown. One sentence under its bar says what a machine is:
"Each machine runs this workspace in a folder of its own. The instances
under a machine run on that machine." It has no About dialog. Its tabs
(`renderer/deployment-tabs.mjs`) are **All**, then one per deployment in
served order, named by `machineLabels`; a view of one deployment has only
that deployment's tab, so the machine is always named. The selected tab is
remembered per view in localStorage (`oats.desktop.deploymentTab`, ids only,
at most 32 views). When the tabs overflow, the strip scrolls horizontally and
the selected or focused tab is revealed, as in the terminal tab strip. The
header's count line counts the selected tab and sits at the right of the
header. The tab has no Spawn button (Spec E): `S` on the canvas (which goes
to the Souls tab), the sidebar's Spawn instance, Quick Open and the soul
cards spawn.

- **All** stacks one section per deployment, headed by `deploymentLabel`
  (the full path in a tooltip) and its counts: the machine in the
  group-label style (uppercase), the `· path` in normal case in the muted
  secondary style, like the counts, and under it "Instances on this
  machine" (this computer) or "Instances on <machine>"
  (`deployments-page.mjs` `deploymentHead`); relations never cross
  sections, and pan, zoom and fit work over the whole canvas.
- **A deployment's tab** shows only that deployment's tree, under its heading,
  even when it is the view's only deployment: every machine's tree is under
  its name and "Instances on …" (the Machines tab, 2026-10-26).
- A non-live deployment's heading carries a state chip ("not reached",
  "remembered", "stale"; "not matched" for a reached one with a reason) and
  its `short` reason, with **How to fix** under it: the `fix` steps when
  there are any (they carry every fact the sentence has, a host or a
  reference), else the full sentence (`reason`), and any `note`. On its own
  tab, a non-live deployment with no rows shows that block as the empty
  state.
- A live deployment's `note` (a remote that now reports another workspace, a
  standalone host's local teams) is said under **Details** on its heading,
  with no chip and no mark. With no rows, the note heads the usual empty
  message.

### Scope per row

- **Instance-addressed** requests go to the row's own deployment,
  `?ws=<row.deployment.id>`: terminal resolution, start, restart,
  lifecycle, readiness, events, Git, the instance's pull request
  and review threads, and capabilities, launch configurations and
  schedules that name a home. The server resolves these
  only by exact deployment id, so a view id there is refused, and
  `admitInstance` resolves a row only inside its own deployment. The
  schedule form's add and update go to the deployment its home list was read
  from, and only while that form is open; a list action (remove, reconcile,
  host install) goes to the view on screen, never to a deployment an earlier
  form read.
- **Deployment-level** requests (the agents catalog, teams and soul teams,
  sync, automations, schedules without a home, capability show and catalog,
  Brain, a soul's launch configurations, spawn preview and apply) may send
  the view id: the server reads the view's primary deployment. Spawn sends
  the chosen deployment's id, and a remote spawn's reply names the view that
  holds the new group.
- **View-level:** `/api/panel`, `/api/team-members` and `/api/forge-roster`
  (the union of the view's local deployments' rows and clones).
- "Is this still the workspace on screen?" checks are keyed by the view id.
  Main lets a caller select every id `servedSelectors(panel.workspaces)`
  returns (`api-url.mjs`): every view id and every deployment id, so a
  deployment id is never rewritten.

### Remembered remote identity

`remote-identity.json` in the app's user data (`server/remote-identity.mjs`)
holds the last identity each remote group reported, keyed by
`<server>:<targetKey>`. It is written atomically (a temporary file, then
rename) with mode 0600; a missing or malformed file is an empty memory. The
file holds at most 256 groups. What one roster answer makes of the memory
(the rules below) is `packages/client/remote-identity-memory.mjs`
(`observeIdentities`), a function over two Maps the store keeps; the store
writes the file when that answer says the memory changed.

- Only a reached group with an identity is a report, and a fresh report
  always wins. A group that reports another workspace moves to that view, and
  its deployment says so for the session ("altair now reports workspace
  tsm.").
- An unreachable group with a remembered identity stays in its view, not
  reached, with `identityFrom: "remembered"`.
- Memory never attaches a local deployment.
- A group that a roster answer no longer lists is dropped, with its memory.
  With no roster answer at all, the remembered groups are shown not reached,
  with no rows and the roster's failure as their reason.

### Reasons

Each deployment that is not live, or not matched, carries its reason in three
parts (`deploymentReasonParts`): `short`, a few words for a heading or the
switcher ("ssh needs a prompt", "OATS too old to report its workspace");
`reason`, the one plain sentence; and `fix`, the plain steps (none when the
sentence already says what happens next, as for a timeout). The sentences:

- ssh needs a prompt or a host key (`E_SSH`): "altair needs ssh to connect
  without a prompt; run `ssh altair` once in a terminal."
- Timed out (`E_CLI_TIMEOUT`). The kernel reports an ssh that timed out as
  `E_SSH`, with ssh's own text or, when its own deadline ended the call,
  "timed out: no answer within N s", so a timeout is recognised from that
  text (a known limit).
- Any other failed read: "<machine> was not reached (<code>)."
- The host's OATS is too old to report its workspace (the group was reached
  but its object has no `key`), or the host reports no workspace (`null`).
- An unresolved member reference (`keyFrom: "member"`): run `oats sync`
  there.
- An invalid reference (`null` key): the ref and "fix oats-local.yaml"; the
  fix step names the ref.
- This computer's deployment whose re-read failed (the last observation kept,
  `E_REMOTE_UNREADABLE`): "This deployment's last read failed. It shows what
  was last observed. OATS says: <the kernel's message>" It is `stale`. The
  Desktop's sentence comes first and the kernel's words after their
  speaker, as one display line. A message the display filter withholds reads
  "[withheld]" in its place, with no "OATS says:" in front; a
  failure with no message reads the Desktop's sentence alone. A kept
  message that carries no speaker (the reader makes none today) stays inside the
  sentence as before, filtered the same way: "This deployment's last read
  failed: <message>. It shows what was last observed."
- An unknown team: "This host hasn't observed its workspace yet; run oats
  sync there."
- Standalone and unmapped: "Teams are local only on this host
  (standalone)." This is a `note`, not a failure.
- This computer's OATS can't read other machines, or is too old to report
  workspaces (no `workspace-identity`).

### Migration

- A selection saved before views (a path or a `remote:…` id) opens the view
  that holds that deployment, and the renderer adopts the view id
  (`staleWorkspaceSelection`).
- Tab memory, open terminal tabs and spawn jobs kept under a deployment id
  move to the view that holds it.
- `servers.json`, saved routes and `workspace-open.json` are untouched: the
  open set still lists deployment directories.
- A group that never reports keeps a view of its own.

## One window per workspace

Main keeps at most one window per workspace view id (`window-set.mjs`). A
window is bound to its workspace by its renderer URL's hash, exactly
`#ws=<encodeURIComponent(id)>` (`renderer/window-binding.mjs`); no hash is a
window with no workspace yet. Every privileged frame check accepts the
renderer file with no hash or that hash and nothing else: another hash or any
query is refused (`trustedRendererUrl`, shared by main, the proxies and the
terminal owner).

- **Requests.** The API proxy reads the sending frame's workspace. A bound
  window's implicit `?ws=` is its own workspace, never main's verified one,
  and an explicit one is never rewritten (`apiUrl`'s bound mode).
- **Binding.** A window switches through `window:claim-workspace`: main
  refuses a workspace another window holds and brings that window to the
  front (or, for a view that moved under a window, doesn't); a deployment id
  is bound as the view that holds it. A take-over (`takeOver`: a pick from
  the list of workspaces, a view's workspace select, going to an instance in
  another workspace) is never refused for that: main asks the holder to
  release it (`window:release-workspace`, answered once with
  `window:release-answer`, from that window only, for its open request), and
  moves the binding when it answers or after 2 seconds. The holder, bound to
  nothing from then, leaves the workspace whenever its renderer runs, on time
  or late: it shows its previous workspace, else the switcher, and closes its
  tabs of it. Its answer may hand the workspace's terminals and split over
  (`renderer/layout-handover.mjs`), passed on whole when valid, else not at
  all; every index is checked, so an array with holes is not valid. A holder
  whose page is loading or reloading still gets the ask: the preload keeps it
  until the shell subscribes (`onWorkspaceRelease`). A page with a hash
  confirms it with main at start (`startWindow`, a claim with focus false);
  a holder's claim of the workspace it is being asked to release settles the
  ask, with no layout, and is answered `open-elsewhere`, so it chooses and
  unbinds itself (`chooseWorkspace`: main may still bind it there when the
  asking window closed before the take-over landed). As a
  backstop, main refuses every workspace-scoped read (409
  `E_WINDOW_NOT_BOUND`) and terminal open (`E_TERM_FORBIDDEN_FRAME`, the
  terminal owner's `admitFrame`) from a frame whose hash names a workspace
  main doesn't bind its window to (`holdsHash`, through the view of a
  deployment id), and a terminal open from a window with no workspace.
  The renderer runs one claim at a time
  and commits a switch only after main's yes (`switchWorkspace` in
  `renderer/views/common.mjs`), so a switch never leaves its hash and main's
  registry apart.
- **A view observed under a window.** A window bound to a deployment whose
  identity is observed later (its view gets a `ws:` id) is moved to that view
  in main as soon as the served list names it (`noteServed`), focusing
  nothing, so no other window can claim the workspace meanwhile (a take-over
  still can). Its hash
  still names the deployment until its next roster read follows the view
  (the #482 rehome claim, a no-op in main by then); its requests stay
  valid in between, the deployment id being served. If another window
  already has the view, nothing moves, and that follow leaves this window
  choosing. A take-over in between names the view, which this window still
  holds under the deployment id: its release matches every id the served
  view holds (`takenWorkspaceIds`), so it leaves, hands over and closes the
  same workspace.
- **No workspace.** A New Window, a window whose view moved to a
  workspace another window has, or the first window of a launch with no
  local deployment to serve, is *choosing*: main's refusal carries the
  served choices, and the window reads nothing until it binds. Its choices
  follow what is served: its roster poll asks main (`window:choices`, which
  re-reads `/api/panel` and binds nothing), so the remote views served a few
  seconds after launch appear. With nothing served, so its list is empty, it
  opens Add local workspace… at once (`showChooser` in `renderer/shell.mjs`),
  where one click runs the normal add and opens the deployment in this
  window; closing the dialog leaves the chooser, whose button opens it again.
- **Records.** `windows.json` (`window-records.mjs`) keeps each window's
  view id, the deployments that view held, its bounds and state, written
  atomically after moves settle. A launch restores the windows whose views
  are served, bounds clamped onto a visible display. A `ws:` view id exists
  only once the server has observed a deployment's identity, a few seconds
  after it starts: until then a record resolves through its deployments, to
  the view that holds one of them (as the server's `viewFor` does), and the
  window follows to its `ws:` view when it is observed, by the same rehome
  claim, focusing nothing. A record goes only when its window is closed
  while its workspace is served, never at quit, or at launch when its view
  and every deployment it names are folders that exist but are not
  deployments (a window once bound to `/`): such a folder is never served.
  A record naming a missing path stays, like a saved deployment on a volume
  not mounted yet.
- **Per window.** Suggestions, picks and adds have a generation and a
  provenance per sending window; adds still run one at a time through the
  one executor, since each replaces the shared server.

## A deployment the server does not serve, or does not answer for

A window never waits silently on "Reading the deployment…":

- **Not served.** The server answers any explicit `?ws=` that is neither a
  view id nor a deployment id it serves (a path, a bare id, a remote it no
  longer has) on `/api/panel` and `/api/agents` with 404 `{ error, code:
  "E_WORKSPACE_NOT_SERVED", workspace }` (`workspaceNotServed` in
  `renderer/deployment-header.mjs`) instead of the first view's data. No
  `?ws=` still means the first view. The main process's API proxy refuses
  the same reads with the same body, without fetching, for a deployment it
  knows (and that is still one) but the server does not advertise
  (`createUnservedRefusal` in `api-url.mjs`). While the server is being
  replaced it refuses against what the outgoing server advertised, so a
  Re-add's own reads are never rewritten to another workspace before the new
  server advertises it. From a window with no workspace yet, an id it does
  not know is still pinned to the verified workspace and the renderer adopts
  the served one (`staleWorkspaceSelection`). A window bound to a workspace
  (below) is never rewritten: any workspace-scoped request of its own whose
  workspace (its `?ws=`, else the window's) is not advertised gets the same
  404 on every workspace-scoped route (`windowRefusal` in `api-url.mjs`).
- **No answer.** A deployment left without an observation, on one
  connection, for `PENDING_LIMIT_MS` (45 s: the 30 s deployment read timeout
  plus the cycle around it) is reported as no answer (`createPendingWatch`).
  The wait runs from the first read that brought none: answered "pending",
  failed in transport (the proxy's timeout, the bridge down) or not answered
  yet. Any other answer ends it, a Retry starts it over, and an observation
  that lands later replaces the error. The deadline is a timer owned by its
  subject (cancelled by an answer, another deployment or connection, a Retry
  or the view's teardown), so it fires at 45 s even while a read that never
  answers holds the poll: both views poll one read at a time and never
  supersede a read in flight. A connection change is the exception: both
  views read on the new connection at once, which revokes the old read's
  outcome and arms the new connection's own deadline.
- **With an observation on screen** (a new connection still reading), a
  "pending" answer keeps the rows as they are, never an empty roster; past
  the bound they go stale with the no-answer reason.
- **Where.** The sidebar roster uses the shared failed state
  (`renderer/loading.mjs`, with a second action) and the Machines tab its
  notice: the message names the deployment path, Retry is always offered and
  **Re-add workspace** when the server does not serve a local deployment.
  Re-add sends that exact path through `workspace:add`, so it restarts the
  server with the whole set. Its outcome belongs to the selection it started
  in: after a switch it does nothing, and a refusal never replaces an
  observation that landed meanwhile. Background re-reads of a failed state
  are not announced again. The switcher keeps offering the served views.

## Remote rows

A remote deployment is one group of the kernel's remote roster (`oats server
roster --json`, projected by `packages/client/remote-roster.mjs`, whose
`remoteRosterState` also decides what a failed or unreadable answer leaves
held), shown in its workspace's view; its rows carry `server`, `home`, and the kernel's
`addressable` and `missingRemotely` facts.

- **One predicate.** `canAddressRemote(row)` in `packages/client/remote-address.mjs`
  (re-exported by `packages/client/instance-admission.mjs`): a local row, or a remote row
  with `addressable === true`. It gates every action on a row: opening the
  terminal, Start…, the row's context menu, the context panel's buttons, the start
  and restart dialog and route, launch configurations, inspection, lifecycle
  plans and applies, readiness, activity, Git and diff, and the wait for a
  started or spawned instance's terminal. Forget… (below) is the one act it
  does not gate. `savedRoute` (spawned from this
  machine) decides only when this computer's OATS predates 0.31 and reports no
  `addressable`: a row it spawned stays reachable through its saved route.
- **Why a row can't open.** `rowReason(row)` in the same module is the one
  source of a row's reason: a short label on the roster meta line (Herdr no
  longer supported, gone from `<server>`, not reachable on `<server>`,
  `<server>` not reached, state unknown), and the full sentence used as the
  row's `title`, `aria-description` and the reason its context menu says. When the
  sentence is the row's own `runtimeError` the reason carries its `origin`
  ([Who made a shown text](#who-made-a-shown-text)); a sentence written
  there carries none. The server label is the registration's label, else
  the server id.
- **Forget a row its host no longer lists (#1131).** The one act on an
  unaddressable row, offered only where `rowReason(row).key === 'missing'`:
  the host was reached and did not list the saved route. A server that was
  not reached, or a state that is unknown, offers nothing. It is on the
  roster row's context menu (right-click, Shift+F10 or the ContextMenu key), as "Forget…" alone (`renderer/instance-actions.mjs`
  with the shell's `openForget`; `packages/client/instance-acts.mjs` is
  unchanged, so the terminal client is unaffected), and in the context panel
  beside the remedy note. Both open `renderer/forget-dialog.mjs`, the
  lifecycle confirmation's dialog without a plan. Forget sends the row's
  `{server, instance}` to `POST /api/server-forget`
  (`server/server-forget.mjs`). The backend runs it only for a row its held
  roster shows gone (#1170): a held group of that server, answered at its last
  read (`probe.ok`), lists that instance with `missingRemotely === true`. Any
  other row, a group held through a failed read among them, is refused with
  `E_FORGET_NOT_GONE` (409): nothing runs and no read starts, and the roster
  is never read again to decide. The checks run in order: the body, the CLI
  (`E_FEATURE`), the held row, one Forget per row at a time (`E_BUSY`). It
  composes the argv of `oats server forget <server> --instance <instance>
  --json` from those two values alone; the kernel's `home` and `target` never
  leave the backend. The route answers as soon as the command's outcome is
  known, and after every command, whatever it answered, it starts the remote
  roster read that follows it (`refreshRemoteSnapshotAfter` in
  `server/oats-web.mjs`: a read already in flight, whoever started it, began
  before the command, so one more runs after it). The backend is that read's
  one owner; the renderer issues none and never edits the view: the row leaves
  the roster when the read lands, and a second Forget before then answers
  `E_SNAPSHOT_UNKNOWN`. While busy the confirmation holds the window: every
  keydown is its own (no shortcut runs behind it) and focus stays on its
  status line. `<server>` below is the server label:
  - forgotten: the status line says "Forgot `<instance>` on `<server>`." and
    focus moves to the first row that followed it when the confirmation
    opened and is still shown, else the roster;
  - `E_SNAPSHOT_UNKNOWN`: "This computer had no saved route for `<instance>`
    on `<server>`; nothing was changed.", focus as for forgotten;
  - another refusal, or a request the backend refused without running
    anything: "Couldn't forget `<instance>`." with the kernel's lines (or the
    Desktop's own reason), focus back to the opener;
  - no answer (a timeout, no envelope): "It is not known whether
    `<instance>` was forgotten.", focus back to the opener.
- **Admission.** `admitInstance` admits a remote selector only in its own
  remote deployment (the same server id in another group is another
  deployment), for a row that passes `canAddressRemote`, when this machine's
  probe lists the operation's `remote` entry (`readiness`, `instance-events`,
  `instance-git`, `lifecycle-plans`). Otherwise it refuses and nothing is sent;
  a local selector never resolves in a remote deployment, or the reverse.
- **Addressing.** Every routed command names `--server <id> --home <abs>`, runs
  from this machine's first deployment directory (else the home directory)
  as its cwd, and carries no
  `--dir` (the kernel sends the registered workspace). Nothing remote is
  addressed by a bare `--instance`. A remote terminal is keyed
  `["remote", server, home]`.
- **Deadlines.** A remote read or plan has 45 s at the CLI (ssh's 15 s connect
  timeout plus the command) and 50 s at the renderer→main proxy; an apply has no
  deadline at the CLI, and the boundary waits 600 s for it (610 s at the proxy);
  a start or restart has none either, and `cliStart` waits 60 s for it.
- **Refusals.** A host refusal is relayed as `{code, message, detail, remote:
  true}` (`hostReason`): the kernel's code, a headline naming the server
  (`remoteHeadline`, the view's own sentence for codes outside its table), and
  the kernel's message as the detail, through the display filter. Every hop
  re-validates it (`remoteReason`: the headline and the detail must each
  already be a display line); views show the headline with the code and detail
  behind Details. A missing `remote` entry is
  "This computer's OATS can't route this to `<server>`. Update OATS here."
- **The display filter** (`packages/client/display-text.mjs`, `displayLine`) is the
  one way a refusal's `detail` reaches a view. Text that looks like a credential,
  or holds DEL or a C0 control character other than tab and line feed, is
  withheld whole (`[withheld]`), tested on the text as given, in time that
  grows with the text's length and not with its square
  (`packages/desktop/test/display-filter-time.test.mjs`). Otherwise it becomes one
  line: tab, line feed and the Unicode line and paragraph separators become a
  space, runs of spaces collapse, the ends are trimmed, each remaining
  character of the waiting note's refused set (control, bidirectional
  embedding, override and isolate, zero-width space, word joiner, BOM, tag
  characters) becomes U+FFFD, and the line is bounded to 2048. The set has one
  definition, in that module. The result is lossy and for display only: two
  texts can become the same line, so it is never compared, selected by,
  sent in a request or used as a path, a command or a name. It is for free
  text, not for a name that identifies something.
  - A view sets the detail as text, alone inside a `<bdi>`
    (`codeLineNodes`); the code and Desktop's own words stay outside it.
  - A refusal's detail never goes into an attribute: the stale line's `title`
    holds the read's message and the code, the code only in the kernel's code
    shape. The detail stays in Details.
  - A headline shows the server's label as a display line too (a label with
    nothing to show reads "the server"); routing, comparison and requests keep
    the label and the server id as the roster reports them.
- **Views.** A remote read in flight says "Reading from `<server>`…". A remote
  row's pull request stays unavailable: the forge reads this machine's clones.
- **Lifecycle.** A remote apply that times out or loses its link is an unknown
  outcome, never a failure; codes the router or the host refuse before any
  effect (`E_REMOTE_INCOMPATIBLE`, `E_AMBIGUOUS`, `E_HOME_MISMATCH`,
  `E_SNAPSHOT_UNKNOWN`) are refused. The routed retire receipt may also carry
  `server` and `target`; a local one may not. After any remote apply the
  remote roster is re-read at once.

## Unchanged, v2-agnostic

With a CLI that lists feature `status-liveness`, a `status` row's `running`, `runtimeState`,
`runtimeError` and `tmux` are the complete local liveness reading, made by the kernel under its pane
rule on every call. The backend then runs no collector and keeps the rows as reported
(`packages/client/deployment-panel.mjs` `kernelLiveness`): there is no `terminal-probe` text on a local
row, and a home with no tmux record has no terminal to open. Nothing fills in a default session. The gate
is the feature of the probe the cycle read with, never the version, whichever route answered the read.

For a CLI without it, terminal-target liveness (`packages/client/liveness.mjs`, run out of process by `packages/client/liveness-main.mjs`)
observes the exact recorded tmux socket/session/window — it reads no deployment
file. It refines a row only when the kernel answered `running` true or false: a row the kernel
answered `running: null` is not probed, and keeps the kernel's `running`, `runtimeState`,
`runtimeError` and `tmux`, because the kernel says unknown also where a probe would say stopped and
be wrong (a missing socket file while a process works in the home, a record that cannot be read).
Such a row stays unknown until the next roster read. A Herdr-recorded row (a `sessionTarget`, or `runtimeState: "unsupported"`)
is never probed: it is reported unsupported with the kernel's E_HERDR_REMOVED
`runtimeError`, or with the E_HERDR_REMOVED stem when an older kernel gave none.
`remotePanel` does the same for remote rows, including an older remote kernel's
`backend: herdr` row, and `unsupportedSession()` in
`packages/client/instance-presentation.mjs` is the one rule both sides use. Such a row
cannot open, start or restart; it can retire. The terminal owner broker, tmux admission, file
guard, spawn preview/apply, lifecycle, events, schedules and Git boundaries are
unchanged; they now receive their roster rows from the kernel observation.

## Retired

`server/deployment.mjs` (config/soul/manifest/lock readers, legacy local-soul
directories, digest replication), `server/model.mjs` (TASK/STATE inference,
knowledge counts), the `oats-web.mjs collect` child, and the catalog DTO
(`server/catalog.mjs`, `/api/catalog`, `renderer/official-catalog.mjs`) are
deleted. Workspace registration validates a directory holding a regular
`oats-local.yaml` (existence only); there is no team-scope sibling discovery.

## Known later-slice residuals

- The composite admission key still names the kernel's roster root
  `agentsRoot` across the preview/apply/lifecycle/events/schedule boundaries.
- The Capabilities tab's classic `list` inventory is a 0.24 surface.
- Souls not yet materialized in `D/agents` (workspace members' souls) are the
  F3 v2 spawn catalog.
