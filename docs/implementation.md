# Implementation reference

A map of this repository for contributors. What OATS does is in the
reference pages ([workspaces](workspaces.md), [souls and instances](souls-and-instances.md),
[capabilities](capabilities.md)); the normative module contracts are in
[the workspace module contracts](design/2026-09-23-workspace-module-contracts.md).

## What is published

- **`@awebai/oats`**: the runtime-neutral kernel (`lib/`), the `oats` CLI
  (`bin/oats.mjs`), the kernel and work-mode instruction sources
  (`injects/`), the bootstrap skills, the docs and the official package
  catalog (`package-catalog.json`). The same tarball carries two
  dependency-free packages of this repository, the turn record
  (`packages/record/`, behind `oats capture`, `recall` and `setup`) and the
  terminal client (`packages/tui/`, behind `oats tui`, a preview:
  [tui.md](tui.md)), and the directory of readers the terminal client shares
  with the Desktop (`packages/client/`, below), which has no dependency
  either. None of their tests is packed. The package's
  manifest declares three runtime dependencies: `yaml` (the kernel reads and
  writes the configuration files with it), `croner` (schedule expressions) and
  `@awebai/pi` (pi's aweb messaging extension). The terminal client adds none
  and may never add one: with a dependency it could no longer ship in this
  tarball.
- **`@awebai/oats-pi`** (`packages/pi/`): a thin pi adapter that exposes an
  instance's own resources. It registers no agent tools. It ships no kernel:
  `extension/core-loader.mjs` imports the kernel that launched the instance,
  through the home's `oats` link, before any PATH or global lookup (the
  order is in [its README](../packages/pi/README.md)).
- **`oats.framework`** (`oats-package/`): the `oats.core`, `oats.setup`,
  `oats.onboarding`, `oats.support` and `oats.knowledge-theory`
  capabilities and the `knowledge-theory-expert` and `oats-setup-expert`
  souls,
  released as a package under its own `oats-framework/v<version>` tags.
  `oats.core` is the one with executables: its spawn and launch hook and the
  Claude Code waiting emitter (`capabilities/oats-core/bin/`).

The OATS Desktop (`packages/desktop/`) is an Electron app with a bundled,
dependency-free localhost server; it is released with the kernel but not
published to npm. Its developer docs are in
[`packages/desktop/README.md`](../packages/desktop/README.md).

`packages/client/` holds the readers of the kernel's JSON that the kernel's
clients share: the CLI adapters and contract decoders the Desktop imports by
relative path and ships beside its `app.asar`, and what a client decides from
the kernel's rows alone (the roster as a tree, which acts a row offers). It is
a flat directory of `.mjs` modules with no manifest of its own, not a package.
`test/client-boundary.test.mjs` holds who may import what: the directory
imports only itself and `node:` builtins, `lib/` and `bin/` import nothing
from it, and the test lists the stable surface a second client may import.

`packages/tui/` is that second client, the terminal one (`oats tui`), in
layers that each do one thing. `lib/term/` is the terminal: the key parser,
cell widths, safe text, the screen and the guard that restores the terminal;
only the screen and the guard write an escape byte. `lib/read.mjs` is every
effect of reading: for each deployment opened in a run it reads through
the shared observer and refresh loop, its background reads through one
warm `oats reader --stdio` of the kernel of the same install (the shared
`createWarmReader`), every other read through that kernel as a child, and,
for a kernel without feature `status-liveness`, the shared liveness
collector as a child too; a void cycle's reads are answered at once,
the warm reader's included; it runs that kernel's read of the
other machines (`oats server roster --json`), one at a time and awaited by
no cycle; it ends every read child and lets changes finish; and it makes the one look at the file
system the workspace switcher needs (whether a picked row is a deployment).
This computer's list of deployments is the kernel's: `lib/main.mjs` reads
and changes it through the shared `cliDeploymentList`, and runs the kernel's
machine sweep of lost sessions when the shared resume trigger says, as a change. `lib/store.mjs` is the state and a pure
`reduce(state, event)`; `lib/model.mjs` turns the state into the rows to
draw by calling the shared readers through `lib/client.mjs`, the one module
that imports `packages/client/`; `lib/views/` are pure functions from that
model and a size to rows of spans; `lib/main.mjs` wires them. It decodes no
kernel answer of its own: grouping, order, states and what a failed read
becomes are the shared readers', so both clients show the same roster.
[`packages/tui/README.md`](../packages/tui/README.md) has the module table
and the rules its tests pin.

## Repository layout

| path | contents |
|---|---|
| `bin/oats.mjs` | the CLI: argument parsing, JSON envelopes, the verbs. Its only static imports are Node built-ins and two dependency-free modules, `lib/compile-cache.mjs` and `lib/hot-reads.mjs`: it turns Node's compile cache on first, then imports the kernel and `yaml` with top-level `await import()`, in their order, because static imports are all parsed and linked before a module's body runs. A hot read (`version`, `session inspect`, `status`, `workspace status`, `instance events`, `instance waiting clear`, given only their own flags) imports only the leaves it uses, never `core.mjs` ([`hot-reads.mjs`](#kernel-modules)); every other command imports every module. A hot read takes its names from `lib/hot-reads.mjs`: a name newly used on a hot read's path must be listed there, under its import line, or its first use throws (a tripwire), and `test/cli-hot-reads.test.mjs` pins what each hot read must not load |
| `lib/` | the kernel (below) |
| `injects/` | the kernel and work-mode instruction blocks composed into every instance |
| `skills/` | bootstrap skills shipped with the kernel |
| `capabilities/` | this repository's own member capabilities (`oats-desktop-ui`, `oats-workspace-experts`), discovered at the member's latest state |
| `mirrors/` | generated byte mirrors of the official packages' capabilities (for example `oats-okf*`, checked by `scripts/check-okf-mirror.mjs`): release-lane and test material, kept out of `capabilities/` so member discovery does not list them a second time; not shipped in the npm package |
| `oats-package/` | the `oats.framework` package |
| `souls/` | this repository's own souls (a workspace member) |
| `docs/` | the reference pages, schemas, design records and release notes |
| `packages/` | the pi adapter, the Desktop, the terminal client (`tui/`), the readers both clients share (`client/`), the turn-record package and experiments |
| `scripts/` | the test runner (`run-tests.mjs`), its reporter of unasserted warnings and the preload that gives each test file a temporary directory of its own, the session-inheritance check (`test-session-inheritance.mjs`), validators, packaging checks, the release lane, the assembly of release-notes entries, and the hand-started named test runs on macOS and Linux (`named-test-run.mjs`, with `macos-tests.mjs` and `linux-tests.mjs`: [named test runs](named-test-runs.md)), and the naming call's isolation proof (`naming-isolation-proof.mjs`, run by hand against real harnesses) |
| `test/` | the kernel and CLI suites, with their fixtures |

## Kernel modules

| module | owns |
|---|---|
| `remote.mjs` | repo refs, reading Git remotes, content digests; `displayRepoRef` and `displayDiagnosticText` select reference-value and kernel-prose contexts for one private renderer, which owns [reference display construction and withholding](workspaces.md#repository-references-in-diagnostics). Selected original refused references first use the contract's bounded plain-value rule; other values supply only validated scheme/SCP, host, supported port and path components, or are withheld whole. Raw host/path fragments inherit plain eligibility only from the original selected source, never from the fragment alone; nonplain originals cannot use that exception. Plain-reference recognition is not a secret detector: credential-like text within the permitted alphabet stays visible. Display recognition shares the parser's character rules without calling its error path, and never changes admission or transport. Explicit pinned-source context retains only a constructed reference plus a validated 40-hex commit, remains idempotent, and has no plain fallback; the default context does not infer pins. Each rejection boundary explicitly names its rejected-input fields; the seven selected argument fields use the same bounded plain-value predicate through the renderer, including spaces and colons and without trimming or decoding, never a global field-name rule. Rejected-input messages quote the rendered fields through a formatter at that boundary, so rejected words cannot replace identical words in the fixed reason. Valid operational values are untouched. Refusal context owns the explanation once; forwarding preserves it. `scrubGitLine` delegates the linked whole-Git-line disclosure rule to the renderer before control/length formatting: only proven unchanged original operation refs plus an original line without `@` permit disclosure; all other lines become the fixed notice, with no substring recovery. Construction tests audit raw Git error-text access and quoting routes; generated invariants cover selected diagnostic routes |
| `local-inputs.mjs` | the local configuration a command read, for `observation.localRevision` |
| `workspace.mjs` | workspace, membership and soul files; discovery |
| `resolve.mjs` | a soul's resolution: capabilities, slots, provenance |
| `packages.mjs` | `packages:`, the catalog, `oats sync`, `oats-lock.json` |
| `capability-show.mjs` | `oats capabilities show`: one catalog row's inject and skill files, read at its commit. Its text rules (`decodeText`, `skillDocDescription`, the limits) are also the rules of `inspect --soul --skills` (`instance-inspect.mjs` `soulSkills`), which reads a soul copy's own skills locally, and of `--composed-skills` (`composedSkillsIn`), which adds the capability skills of the scratch composition |
| `materialize.mjs` | the shared home composer for spawn and module upgrade: `stageMaterialize` stages module copies and derived files, then a durable rename journal commits or rolls back a replacement in an existing home; `moduleSkills` is the one rule for which skills a module gives, read over the fetched tree, or over a remote listing for the spawn preview (`plannedModuleSkills`) |
| `instance-upgrade.mjs` | `planUpgrade` and `applyUpgrade`: verified package-module staging, provider adoption, idempotent forward completion, undo and retirement baseline refresh for a stopped local home, using the shared composer for derived home files |
| `compile-cache.mjs` | the CLI's Node compile cache (awebai/oats#1630): `$OATS_HOME_DIR/compile-cache`, made 0700, unless the caller's `NODE_COMPILE_CACHE` or `NODE_DISABLE_COMPILE_CACHE` decides; any failure is no cache and prints nothing, and `NODE_COMPILE_CACHE` is never put in the environment children inherit ([configuration](configuration.md#the-compile-cache)). Node built-ins only; kernel-private, not in `./core` |
| `hot-reads.mjs` | the CLI's hot reads (awebai/oats#1630), and the warm reader's start (`oats reader --stdio`, whose reads `reader.mjs` imports itself): each one's form (its words and the flags it takes) and, for each import line of `bin/oats.mjs`, the leaves it loads in that line's place; a line it does not list loads nothing, and any other argv loads everything. A name a read does not list is a tripwire: destructuring it is free, and any use throws a `HotReadUnlisted` defect naming the read, the line and the name. `test/cli-hot-reads.test.mjs` runs each read with a load hook and pins what it must not load. Kernel-private, not in `./core` |
| `roster-read.mjs`, `workspace-read.mjs`, `read-call.mjs` | the deployment reads (awebai/oats#1630): `oats status` (`roster-read.mjs`: the roster, its drift and its workspace identity) and `oats workspace status` (`workspace-read.mjs`: members, packages, automations, the desktop facts, and the rows `oats sync` reports too), one implementation behind the CLI and a process that answers them many times. Each has an answer function (`statusAnswer`, `workspaceStatusAnswer`: `{ exit, answer, stderr }`, `answer` the JSON the CLI prints, a refusal included) and a data function (`statusView`, `workspaceStatusView`) bin's text renderer reads. `read-call.mjs` is one call's scope: it takes an explicit context (the absolute `dir`, `maxAge`, the caller's read session, the cache, an optional deployments observer), resets at its start every piece of module-level state the reads can reach (`READ_STATE`; `test/read-call-state.test.mjs` scans the reads' import closure and fails on a binding with no row), answers refusals as envelopes, and drains the session's notices. Within one call, two pieces of work are not repeated: `listInstances` hands the records it read to the rest of the read (`records`: `legacyCapturedHomes` and the waiting read take them instead of parsing them again), and `workspace status` asks git for each member clone's remotes once (`remotes`, shared by the automation scope and the desktop facts); both are maps the read makes and drops, never module state. A call registers no process listener, closes no session and reads no argv or cwd: the CLI passes `commandSession` (created at the first remote read, with its exit and signal listeners) and closes it at the end of the command, as for every verb. The read part of the dispatch is there too (`parseMaxAge`, `readBudget`, `callSession`); `test/read-call-equivalence.test.mjs` answers both reads many times in one process and compares each answer with a fresh CLI run's. Leaves: never `core.mjs`. Kernel-private, not in `./core` |
| `reader.mjs` | `oats reader --stdio`, the warm reader (awebai/oats#1630; [the contract](desktop-cli-api.md#the-warm-reader), [the decisions](design/2026-10-29-warm-reader.md)): a client's child that answers `oats status --json` and `oats workspace status --json` on its stdin and stdout, many times, through `read-call.mjs` and the two answer functions, never a copy of them. It loads every module the reads import lazily (`PRELOAD`) before its hello; classifies a request with `hot-reads.mjs` `hotRead` and expands its flags with `argv.mjs`, then runs the dispatch's read part in the CLI's order (the flag syntax, `--max-age`, the inherited context), so a refusal there is the CLI's own answer; answers one request at a time, in arrival order, each with its own read session, closed at its end, and its deployments observer; changes its working directory to the request's `--dir` for the read and back to the install root after, because the programs the reads run by name resolve a relative `PATH` entry against it (a second lane must first give each child its own cwd). It compares `install-stamp.mjs`'s stamp, taken by `bin` before the kernel loaded, when a request starts and before its answer is written: a change refuses `E_READER_STALE` and exits. Its stdout carries protocol lines only (other writes go to stderr); a request in flight at exit has its session closed from the `exit` handler. `test/reader-protocol.test.mjs` pins the protocol and `PRELOAD` against the reads' closure. `oats reader --stdio` is a hot-read form, so `bin` loads only its dispatch's leaves for it, never `core.mjs` (`test/cli-hot-reads.test.mjs`). Kernel-private, not in `./core`. Dependency-free |
| `install-stamp.mjs` | the warm reader's install stamp: `stat` of the install's code and data (package.json, bin/oats.mjs, the catalog, every file under lib/, the docs schemas, each runtime dependency's package.json where it resolves now, the Node binary) as one string. Node built-ins only: `bin` imports it statically and takes the reader's baseline before any kernel module loads; `reader.mjs` compares each request against it |
| `argv.mjs` | how the kernel reads `--flag=value` ([Flag syntax](desktop-cli-api.md#flags)): `expandInlineValues`, which the CLI's dispatch runs once on its argv and the reader on each request's, so both give a malformed flag the same `E_BAD_ARGS`, and `flagValue`, a flag's value in an expanded argv. Kernel-private, not in `./core`. Dependency-free |
| `kernel-features.mjs` | `KERNEL_FEATURES`, the features this kernel implements: `features` in `version --json` and in `status --json`; `READER_API`, the warm reader's protocol number (`readerApi` in `version --json` and in the reader's hello). Kernel-private, not in `./core` |
| `captured-context.mjs` | the refusal (`E_UNSUPPORTED_MODE`) of an environment that carries `OATS_RESOLUTION` or `OATS_DEPLOYMENT`, which the dispatch asks for every command but `version` and `reader`; the reader asks it for each request instead, so it starts and answers each read as the CLI would. Dependency-free |
| `repo-moves.mjs` | the moved repositories: `currentRepoKey` and `sameRepo`, what a compare of two repository keys goes through. It compares and never rewrites ([Moved repositories](workspaces.md#moved-repositories)). No I/O, no imports. `packages/client/repo-moves.mjs` is the same file, byte for byte, because the kernel and the clients import nothing of each other; `test/repo-moves.test.mjs` pins it |
| `version.mjs`, `deployment-path.mjs`, `write-file-atomic.mjs`, `agents-root.mjs`, `soul-listing.mjs`, `instance-address.mjs`, `session-inspect.mjs`, `instance-listing.mjs`, `drift.mjs`, `package-catalog.mjs`, `member-clone.mjs`, `reserved-launch-env.mjs`, `automation-scope.mjs`, `automation-api.mjs`, `semver.mjs` | the leaves the hot reads load instead of the modules that re-export them (awebai/oats#1630): the version; the canonical deployment path; the atomic file write; the agents root; souls and instance homes; `resolveInstance`; `inspectInstanceSession`; `listInstances` and the status rows; soul and module drift; the official package catalog; discovery and member clones; the reserved launch environment; the automation scope; the automation API versions; `compareSemver`. Each name is still exported, under the same name, from the module it left (`core.mjs`, `packages.mjs`, `instance-lifecycle.mjs`, `materialize.mjs`, `instance-resolution.mjs`, `schedule.mjs`, `automations.mjs`, `servers.mjs`), so `./core` is unchanged (`test/core-exports.test.mjs`), and no leaf imports `core.mjs` or the module it left. Code a hot read reaches goes in a leaf, never in `core.mjs` |
| `upgrade-state.mjs` | upgrade receipt state and the partial-upgrade guard used before session start; receipts remain lifecycle state, and provider adoption stays in the module's upgrade hook |
| `core.mjs` | spawn, retire, sessions, hooks, launch recipes, instance metadata. A home's record (`instance.json`) is read with `readHomeRecord`, which never throws: a record, an absent one, or one that is there and cannot be read, with the reason. Code that walks other homes (the listing, a retire's lineage repair) uses it, so that one home's record decides only for that home; `identifiedHomeRecord` is the one refusal (`E_UNIDENTIFIED_INSTANCE_HOME`) a lifecycle verb makes when it has resolved its home: `resolveRetireHome`, `startInstanceSession`, and `resolveTarget` in `instance-lifecycle.mjs` for the stop and retire plans. A plan reads its own home's record with `targetRecord` (the same refusal) and any other home's with `otherRecord` (absent or unreadable: nobody's parent or child) |
| `instruction-composition.mjs` | the generated `AGENTS.md`; `renderInstructionParts` is the span-reporting renderer (`renderInstructionText` is its text) |
| `soul-composition.mjs` | the instructions a spawn of a soul would write, composed without a spawn (kernel half + materialize into a scratch home): the one path behind `doctor --soul`, `inspect --soul --instructions` and `--composed-skills` (its `inScratch` reads the scratch home before it is removed, so the two flags share one materialization) |
| `instance-naming.mjs` | the suggested instance name of `spawn --suggest-name` (a preview's or an apply's) and of `oats instance suggest-name`: the prompt, the soul's role (`soulRole`, the clients' rule), the name built from a reply, each harness's proven naming call (`NAMING_CALLS`) and the isolated call itself. Two drivers in `core.mjs`, both reusing it unchanged: `spawnBody`, after the spawn's harness checks, where a suggested name is then placed as `--name` would place it (a preview's call within its preflight budget, an apply's within its own 20 s); and `suggestSpawnName`, for a spawn elsewhere, which resolves the launch configuration and executable the way a spawn here would but places nothing and passes a `taken` that is always false. The test seam `OATS_TEST_NAMING_TIMEOUT_MS` shortens the call's 20 s limit |
| `doctor-capture.mjs` | one fixed bounded package health child for deployment doctor, excluded from `--soul`; package-owned envelope validation and existing warning-row mapping. No kernel status/DB/freshness parser. Command failures become `capture-health-unavailable`; see [the package boundary](../packages/record/docs/capture-service.md#kernel-doctor-delegation) |
| `teams.mjs`, `teams-verbs.mjs` | the team model and the `oats teams` verbs |
| `local-edit.mjs` | the one way a verb rewrites `oats-local.yaml` in place (`editLocal`): the file as it is now, the deployment's local lock, compare-and-swap, the local schema and the caller's check before the rename, and the permission bits of the file it replaces on the new one (a link at that path is replaced by a regular file with its target's bits, and the target is not written). Every kernel command that rewrites that file writes through it (`grep editLocal` lists them; this row does not), and a new writer does too, so that no two drop each other's change. An edit changes the parsed document, which is then rendered, or returns the text to write when the command has a writer of its own for its block (`oats launch-config set\|remove`, whose write leaves every byte outside `launch-configs` as it was) |
| `launch-preference.mjs` | a soul's launch preference, pure: the layers a new launch reads, the `Launch` report, and `launchKeysUnmatched`, the one function that decides which keys of `souls.launch` name no soul. It decides from a description of one read of the workspace (`soulsOffered` in `instance-resolution.mjs`, built from the discovery and its `soulsUnread`); a reader never computes the answer itself. What a read did not record, it did not establish: a discovery with no `soulsUnread` leaves every key unchecked (`unrecorded`), and a member's enumeration with no `soulsSkipped` counts as one with a soul skipped (`skippedSome` in `workspace.mjs`). `launchLayers` takes that description and carries the unmatched keys, so every caller that has layers has the fact, and `launchPreferenceUnmatched` is the one constructor of `E_LAUNCH_PREFERENCE_UNMATCHED` (its code and the bound of its texts are the exported `LAUNCH_PREFERENCE_UNMATCHED` and `LAUNCH_PROBLEM_TEXT_MAX`): `selectNewLaunch` throws it and `launchReportFor` reports it, both in `core.mjs`, before the refusals that describe the fall-through launch. `soulLaunchCommand` is the one place the command an answer suggests (`oats soul launch set\|remove …`) is rendered: the `fix` of a launch refusal (`harnessFix`, `launchConfigUnknownFix`, `launchConfigAmbiguous`), the texts about an unmatched key and `oats doctor`'s `remedy` all call it, and none tells a person to edit `souls.launch` in the file. The one exception is made there too: a key that holds a character the kernel never prints (`REFUSED_TEXT`) cannot be written into a command line, so the function gives no command and says the key is deleted from the file by hand; `launchKeyQuoted` is the one quoting of a key in a sentence, with such a character replaced (`safeText`). No sentence checks its key itself |
| `shell-word.mjs` | `shellWord` and `shq`: one word of a command the kernel prints for a person to paste into a shell. It imports nothing, so `launch-preference.mjs` quotes by the rule `core.mjs` re-exports |
| `soul-launch-verbs.mjs` | `oats soul launch set\|remove`, the writer of `souls.launch` |
| `schedule.mjs`, `schedule-host.mjs`, `triggers.mjs`, `automations.mjs` | schedules, triggers and the host timer |
| `session-end.mjs`, `session-resume.mjs`, `session-resume-contract.mjs`, `session-seen.mjs`, `start-env.mjs` | session resume (#1559): what every local listing saw of each home and the pure rule that decides which losses the sweep resumes (`session-seen.mjs`: one producer, `listInstances`; never in the way of the listing); the contract's names (`sessionEnd`, the start's `resume` object, the sweep's outcomes and reasons, the feature) in one dependency-free module that every producer, test and doc reads (awebai/oats#1567 settles them); how a launched home's last session ended (`sessionEnd`, from the kernel-private exit marker and stop record, both forms of the marker), and the machine sweep `oats session resume` with its lock and its per-boot note (refusals, and the count behind the bound of 3 sweep starts per home per boot); a resume holds the home's lifecycle claim (`claim.mjs` below), as every start does, the sweep's status-row read of a retire or a claim holder is only its filter, and every stop OATS does writes the stop record through `core.mjs` `recordStop`, a retire's before its window kill; the record of each start's `fromEnv` values (`start-env.mjs`: a keyed digest per variable, never a value) and the one check a resume and `--plan` share, so a resume never starts under a changed value; the conversation a resume continues is `packages/record/lib/last-conversation.mjs` |
| `stable-node.mjs` | the one rule for a node path written into anything that outlives the process: the host timer's unit and `OATS_NODE_BIN` ([capabilities](capabilities.md#the-node-a-hook-writes-down)). It imports nothing of the kernel |
| `trigger-sources.mjs` | a capability's `triggerSources`: the use-time validator (per source, never from the manifest contract or discovery) and the source wire's answer and event rules; `triggers.mjs` runs a source with `instance-inspect.mjs`'s `runModuleCommand`, the provider-check runner |
| `refused-text.mjs` | the one set of characters the kernel never stores or prints in text it did not write (`REFUSED_TEXT`), and `safeText`, which replaces them |
| `schedule-command.mjs`, `schedule-command-child.mjs` | synchronous scheduler adapter and asynchronous child supervisor: bounded output, TERM/KILL escalation and observed exit; no changes to synchronous tick/lock callbacks |
| `operator-dispatch.mjs` | capability commands run from a deployment, and its module store |
| `operator-coverage.mjs` | whether a soul the workspace offers composes `oats.setup`, for the workspace and each team (readiness and doctor warnings), and the cache-only remote offline doctor resolves through |
| `instance-*.mjs` | inspection, lifecycle, events and Git views of an instance; `instance-color.mjs` is an instance's colour, its palette (pinned equal to `packages/client/soul-colors.mjs`) and its home record, which every reader goes through; `instance-background.mjs` is the same for whether an instance is background: its home record, read by the rows, inspect and the command, and written by spawn and the command; `instance-same-work.mjs` is an instance's same-work flag, its home record bound to a parent, and `sameWorkOf`, the one rule of whether it is on, which status rows, spawn and `oats instance same-work` go through |
| `worktree.mjs` | `oats worktree add\|remove`: an instance's extra trees (`.work-<purpose>`), their records (`.oats/trees/`), argument checks before any write, the rollback of an interrupted add, and completion of Git's partial removal. An unregistered residue with a dangling `.git` file is compared with the recorded branch through a private temporary index (`read-tree`, refresh, `diff-files` allowing deletions, and `ls-files --others --exclude-standard`) before permissions or files change; the clone's index is never used. Only clean residue is made writable, without following symlinks, and deleted |
| `errors.mjs` | `oatsError`, and the door of the lifecycle verbs: `isKernelCode` (the shape of a kernel code, `^E_[A-Z0-9_]+$`, never a list of codes), `kernelCode`, `asKernelError` and `errorCause`. An answer of `oats retire`, `oats instance stop`, `oats session` and `oats worktree` carries a kernel code, or one of the two names every command answers as they are (`OWN_NAME_FAILURES`: `unsafe-config-key`, `unsafe-config-value`), and no other: `isAnswerCode` is what the door and its wrappers keep, `isKernelCode` stays the test of the shape. An error of the system's or of Node's, a refusal written as a plain `Error` without a code, and a defect (`isDefect`: a `TypeError` and its like without a code, or a thrown value that is no `Error`), is wrapped at the boundary (`bin/oats.mjs` `lifecycleFail`; in a retire, `core.mjs` `retireClaimed`, which also says what the retire had done by then) and its own code goes to `details.cause` (a defect's name does; a plain `Error` without a code has no cause, and is answered with the general code and its message alone, which is what an ordinary refusal of `tmux`, `git` or the kernel itself must read as). New code that answers an error tests the shape with these, never `e.code \|\| "E_…"`: a system error has a `code` too. Whoever ends an error's way up prints the stack of a defect with `reportDefect`: the door, and any code that turns a caught error into a row of results (a stop's `results[]`, a retire's `childrenStopped[]`), after which nobody else can. Two more rules of the lifecycle verbs live here. **`lifecycleBusy(holder, said, remedy, details)` is the only way `E_LIFECYCLE_BUSY` is made** (`test/lifecycle-busy-holder.test.mjs` scans `lib/` and `bin/` for any other): it sets `details.holder` (`BUSY_HOLDERS`: `"running"` only where the kernel established that the other command is alive, `"unknown"`, `"none"`) and refuses to build an `"unknown"` or `"none"` answer without the step that ends it. **`BEFORE_EFFECT_CODES` lists, per verb, the codes that verb answers only before any effect**; `afterFirstEffect` turns a listed code raised after a verb's first effect into a defect (`E_LIFECYCLE_FAILED`, `cause.name: "LateRefusal"`), and is called at the one place of each verb that knows how far it got (`core.mjs` `retireFailure`, from `at.phase`; `instance-lifecycle.mjs` `applyStop`, from whether a target's stop began). A code may join the list only when every place that raises it in that verb is before the first effect; a place found after it gets a code of its own, never the net |
| `claim.mjs` | the claim: one file naming, by pid and start time, the process doing something that happens once at a time; taken over when its holder is verifiably gone, never when that cannot be read. Synchronous. Held by `oats worktree add\|remove` per purpose (`worktree.mjs`), and per home by `oats retire`, `oats instance stop --apply`, `oats instance upgrade`, `oats session start --resume` (verb `resume`) and every other session start and restart, a scheduled start included (verb `start`, #1602; `core.mjs` `startClaimed`, before the start lock: two starts are answered `E_SESSION_START_BUSY` from the claim, `startPair`; a path with no record it can read takes no claim (`readHomeRecord`, as every lifecycle verb reads its record first); the start runs on the home's path on disk, and a home given through a link first answers what a start of the path as given answered before any guard (`startRefusals`, in their order; a partial upgrade is left to the claim while an upgrade holds it, `upgradeHoldsClaim`, as the CLI's pre-check does), then is held to its own authority on the path as given, `sessionDirectoryGuard`, then again with every check of the start's roots; an owned directory home must resolve to the home its own receipt records, bound by the receipt's paths, not by a second read of the disk: `requestedHomeGuard`) (`core.mjs` `claimHomeFor`: the one way a verb takes a home's lifecycle claim; the record names the holder's verb, `action`, from the instant the file exists, through the `facts` option of `acquireClaim`). A verb that only reads the home's claim (`oats worktree add`; a stop plan's `retiring` and `stopPending`) uses `homeClaimHolder` or `refuseBesideRetire`. The refusals of every pair (arriving verb, holder's verb) are built in one place, `core.mjs` `lifecycleClaimRefusals`; the pair table of `docs/desktop-cli-api.md` is walked by `test/lifecycle-pair-table.test.mjs`. A new verb that must not run beside a retire takes the claim through `claimHomeFor`, joins `CLAIM_VERBS` and adds its row and column there. Its loop has one rule: every pass that does not take the claim falls through one check of its time and one pause, so no state of the path makes it spin. Each caller words the refusals (`busy`, `unreadableClaim`, `cannotTakeOver`, `heldAgain`, `ownStartUnreadable`), and is handed with each what the acquisition's takeovers ended before it (`ended`): it writes "nothing else was done" then, and the answer is `E_LIFECYCLE_FAILED`, what was ended first (`errors.mjs` `nothingAfter`, `afterEndedSteps`; `lifecycleBusy` takes `ended`). No message is rewritten after it was made. A claim is read back as whatever is in its file, which others than its writer can write, so no text of it enters an answer: a refusal names the holder through `shownHolder` (its pid, time and start, each only in the shape the kernel writes) and `core.mjs` `claimAction` (one of `CLAIM_VERBS`, the list `claimHomeFor` accepts). A claim that could not be WRITTEN is marked at the write that failed (`claimWrite`: the claim's directory, its private file, its link, and the same of a takeover's own claim) for the system's code as it was thrown there, one of `CLAIM_UNWRITABLE_CODES`; the mark travels on the refusal (`unwritableCode`), and an answer made after a takeover ended something carries none. One caller reads it, `claimHomeFor` with the option `READ_CLAIM_WHEN_UNWRITABLE`, which a stop apply passes and nobody else: it then reads the claim where it would have taken it (`claimUnheld`: nobody, or the refusal the taking would have given, from the same builder) and answers a holding without a claim, whose `look()` makes that read again. No caller tells that failure from another by an answer's code, words or `details.cause`: a defect and a claim that could not be removed are `E_LIFECYCLE_FAILED` too |
| `write-through-private-file.mjs` | the one writer of a file written through a private file beside it and renamed over it (`writeThroughPrivateFile`; `exact` gives the mode whatever the umask, as `core.mjs` `writeHomeRecord`, the kernel's write of a home's record, needs): a failed write or rename removes the private file and throws that failure's error (#1076). The caller gives the private name, the bytes and the mode. A writer that needs more (an exclusive link, a failed removal reported, a sync) keeps its own code |
| `worktree-hooks.mjs` | the `worktree` event's runner (cwd the tree, detached process group, log under `.oats/logs/`, fixed timeout, interrupt handling), process identity by pid and start time, and the credential-free `origin` URL. Two questions, two functions: `processStart` says whose a pid is (a zombie still holds its pid and start, which is what proves a recorded process group), `processLiveness` says whether the `oats` command a record names can still act (a zombie cannot: it is gone). Ask `processLiveness` only about an `oats` command's own process, never about a hook's or a harness's pid. `runPs` is the one way the kernel calls `ps` where an identity is read: the program, the fixed environment and how the answer is classified. `isStartToken` says the shape of a start token, once, beside its writer: it decides what of a record may be shown (`claim.mjs` `shownHolder`, `unknownGroupNote`), never whether a process lives |
| `system-tools.mjs` | `systemTool`: a program the kernel runs from the system directories (`SYSTEM_TOOL_DIRS`), never from the caller's `PATH`. `ps` runs on the same directories: `worktree-hooks.mjs`'s `PS_ENV` takes its `PATH` from them |
| `tmux-server-scope.mjs` | where sessions run on a systemd host: whether the OATS tmux server starts in a scope of its own (the creator's cgroup judged: Linux, unified hierarchy, inside a `.service` or a scope of the user manager), and whether each agent's harness is launched in one (`agentScope`: the probe, run with the pane's bus variables and cached per process, and the wrapper `nativeRecordCommand` renders); the scopes' names and the warnings when they cannot |
| `tmux-config.mjs`, `session-*.mjs` | the tmux session backend and terminal input |
| `login-environment.mjs` | the user's login environment a server OATS starts gets: the login shell's answer as one nonce-framed block on its stdout, bounded and accepted only whole ([execution targets](execution-targets.md#the-servers-start-environment)) |
| `capability-contract.mjs`, `provider-binding.mjs` | manifest validation (launch environment, hooks, `retirement`) as problems and warnings (`manifestContract`: an unknown, non-required hook event is a warning every reader reports), the hook environment rules, the readiness wire |
| `retire-output.mjs` | the lines `oats retire` prints for preserved work, one function for the local and the remote path |
| `status-words.mjs` | the word `oats status`, `oats status --server` and `oats server roster` print for an instance row (RUNNING, LOST, idle, unknown, RETIRING; the roster keeps its own suffixes) and the line under a LOST row that names the way back; rows in, strings out, the JSON untouched |
| `retire-state.mjs` | a status row's `retire` (feature `status-retire-state`): `readRetireState`, the one read of the value, which the local row (`core.mjs` `retireStateOf`, from the marker, its result and the home's claim) and the remote roster's relay (`servers.mjs` `rowRetire`) both go through. Pure; status only reads, so nothing here takes a claim, removes a file or signals a process |
| `retained-after-retire.mjs` | what retires left behind (recovery copies, retained worktrees) as `oats doctor` information lines: read-only, Git through `instance-git.mjs`'s helper-free reads |
| `retire-incomplete.mjs` | retirements left open (a quarantine, a failed or interrupted self-retire) as `oats doctor`'s `retire-incomplete` problems (oats-project/oats#1747), read with `instance-listing.mjs`'s `openRetirements`, the readers of the status rows: read-only, no claim, no tmux |
| `read-ahead.mjs`, `read-ahead-worker.mjs` | read-ahead for the tree digests (`fingerprintTrees`): while a digest reads a tree on the calling thread, a planner thread walks it in the digest's order and a few reader threads read the next files into the page cache, within a window of bytes and files ahead of the digest. The digest still reads and hashes every byte itself, so no value or error depends on it; one that cannot start or falls behind costs speed only |
| `file-pieces.mjs` | a regular file's bytes read in pieces of 1 MiB (`readFilePieces`, `hashFile`, and `readFileUpTo` for a home's `instance.json`, read whole up to 16 MiB for its neutral form), for every digest of the retire path: what a digest holds of a file is bounded whatever its size (Node reads no file over 2 GiB whole), and a file is read for the size it had when it was opened. One that ends before that size refuses with `E_WORK_INSPECTION_FAILED` |
| `session-input.mjs` | session inspection and input transport. `resolveAgentPane` is the one rule for which of a window's panes is the agent's (the `@oats-agent` mark, `AGENT_PANE_OPTION`, that the launches in `core.mjs` set); `harnessProcesses` (Stop) and the viewer use it too. `createSessionPaneInspector` resolves the agent's pane, then interprets it for both lifecycle inspection and status, sharing a lazy process scan across a status read; a shell-labelled pane is a fallback shell only when that scan shows the pane's own process as a shell with no non-shell descendant, and a scan that cannot show it throws its reason (unknown, never idle: #1641); `core.mjs` batches pane reads per socket/session and applies its shared `harnessRunning` predicate |
| `servers.mjs` | routing commands to a registered server |
| `deployments.mjs` | this computer's deployments ([workspaces.md](workspaces.md#this-computers-deployments)): the per-user files `<OATS_HOME_DIR>/config/deployments.json` (the list, 0600 in a 0700 `config/`) and `config/deployments.lock` (`withDirLock`, waited for up to 3 s), the bounded no-follow read, the atomic write, the first-use `~/Agents` import (the real `$HOME`) and the five `E_DEPLOYMENTS_*` codes. `oats deployments`, onboard's `listed` and the auto-add write through it. `listResolved` is the auto-add: `bin/oats.mjs` sets it as the observer of `resolved-deployment.mjs` for the commands in its one table (`LISTS_ITS_DEPLOYMENT`), so it runs once per process on the deployment the command itself resolved. A listed deployment costs one bounded read (no lock, write, process or realpath), another spelling of it a realpath; a spelled root in a linked worktree or submodule (a `.git` file above it) is left to the commands that resolve its canonical root; a root under a temporary directory (`underTemporaryDirectory`, awebai/oats#1397) is never auto-added; only a path not listed is canonicalized and takes the lock, without waiting for it. It never throws or prints |
| `resolved-deployment.mjs` | the deployment a command resolved: `loadLocal` (`workspace.mjs`) reports the directory it found as spelled, `ensureRoot` (`agents-root.mjs`) the canonical one, and the observer the CLI set is called once, at exit, with the first canonical root (else the first spelled one), so an earlier spelling never stands for a root the command canonicalized. A no-op until the CLI sets one, so library callers and tests are unaffected. A process that answers many reads sets its observer with `atExit: false` and settles it at the end of each read (`read-call.mjs`), which also forgets what the last one reported (`resetResolvedDeployment`). Dependency-free |
| `launch-prompt-evidence.mjs` | private bounded storage of exact unmatched, stable-screen completed or flag-ignored notice frames, original-home identity checks and receipt-last publication; no terminal operations or public raw text |
| `launch-prompt-completion.mjs` | the 21 question markers that block after the development-channel Enter; reporting only, never an input matcher |
| `launch-prompt-fixtures.mjs` | the development-channel tolerance list (`launch-prompt-fixtures/dev-channel-confirmation.json`): engagement from the argv, the enumerated normalization, equality matching, the `flag-ignored` notice block, the running-session banner hint, what differed, and the Claude version read from the executable's path |
| `launch-prompt-resume.mjs` | the report-only watch of a resumed Claude pane for its resume-cost dialog (`resume-confirmation` entries in `launch-prompt-fixtures/resume-confirmation.json`, matched by whole option labels): at most 20 s, never a key |
| `launch-prompts.mjs`, `launch-prompt-transport.mjs` | bounded launch-only controller and visible-screen transport; private process authority, injectable clock/transport, durable checked receipts, one Enter only on equality with a tolerance entry |
| `harness-trust.mjs` | read-only native trust coverage and operator remedy for launches; the table of the variable that moves each harness's folder (`HARNESS_FOLDER_VAR`) and the one reader of a launch configuration's (`launchConfigFolder`), used by the trust code, `pi-bridge.mjs` and `core.mjs`: it reads only files and imports none of them. What a launch's pane will have for those variables, `PATH` and `HOME` is `launchEnvironment` in `core.mjs`, the one answer every check of a launch reads ([execution-targets.md](execution-targets.md#the-checks-read-the-pane)); it carries the names the launch removes (`removedLaunchEnv`: declared by its capabilities, not in their payload), which `launchEffectiveEnv` leaves out and the window command (`paneCommand`) unsets ([capabilities.md](capabilities.md#a-declared-name-is-the-providers)) |
| `harness-trust-write.mjs` | explicit operator plan/apply, cooperating locks, durable deployment audit and no-rollback outcomes |
| `harness-trust-json.mjs`, `harness-trust-toml.mjs` | bounded native parsers and byte-preserving edits of one trust leaf |
| `pi-bridge.mjs` | the pi bridge (`@awebai/oats-pi`) in every pi folder a launch of a deployment uses: the folder list (the default, the process's own `PI_CODING_AGENT_DIR`, each pi launch configuration's, by real path), the bridge read in each, `oats doctor`'s skew warnings, and the plan `oats update` runs with its line that the Desktop goes first ([upgrading](upgrading.md)). Reads only: `bin/oats.mjs` runs the steps |

An upgrade records a hook's in-flight marker before spawning it. A resumed
unknown outcome is durably recorded as uncertain before any retry work,
because the provider may already have changed host state even when no success
was recorded. Success or uncertainty makes the act forward-only. Only a
non-zero result observed and recorded in the same invocation, with no prior
success or uncertainty, permits rollback of composed bytes. An uncertain hook
is retried idempotently; a later refusal cannot turn that recovery into a
rollback.

Start and upgrade share the `.oats-start.lock` path through exclusive
acquisition: start uses `mkdir`, while upgrade creates a regular file with
`wx`. Both treat `EEXIST` as held. Upgrade takes the lifecycle claim before
reclaiming an interrupted upgrade's regular-file mutex, including an empty
file left by a killed opener, and never reclaims a directory. Start never
reclaims this path. Upgrade releases it only after persisting its final
invocation receipt. A start takes the lifecycle claim before this mutex too
(#1602), so beside an upgrade that runs it is refused at the claim; it meets
the mutex only when an upgrade that died left it.

Upgrade compares the home with its independent spawn baseline before it
changes anything there. A dirty home retains the entire baseline byte for
byte, so older kernels also recover its edits at retire. A clean home updates
only `homeFingerprint`; work fingerprints, digest versions, exclusions and
runtime authority remain as recorded. `retirementHomeChanged` and
`rebaseUpgradeRetirementBaseline` use retirement's existing comparison and
exclusions, without changing recovery or copy semantics.

The fingerprint helpers accept call-scoped `transientHomePaths`: exact
relative paths, no globs, each an existing regular file. Upgrade projects out
only `.oats-start.lock`. This is not a permanent exclusion: a later retire
hashes any leftover mutex as changed home bytes. The completed receipt is
published before the success event. A same-key retry deduplicates the event
and removes staging, without repeating adoption or composition.

Baseline replacement uses the existing atomic private-file writer. The
exclusive-create option still refuses an existing baseline. An interrupted replacement leaves a complete
old or new baseline, preserving the independent session authority required
to resume forward recovery.

The schedule registry stores explicit concurrency caps, leaving the schedule
cap absent for its effective default of five. `readRegistry()` is a pure,
bounded atomic-file snapshot: it takes no lock and writes nothing, projecting
legacy implicit one to absent and `capsVersion: 2` only in memory. Its no-follow
regular-file descriptor accepts an atomic rename between stat and open, so it
returns a complete old or new snapshot; other bounded readers retain their
identity check. Invalid present schedule or trigger caps are refused.
Registration, unregistration and cap updates reread under `registry.lock` and
compare against the raw snapshot, so even unchanged membership persists the
migration. A successful write removing legacy one emits a stderr notice naming
the one-slot restoration command. `writeRegistry()` remains a raw atomic writer;
read-modify-write callers must supply the lock and reread. Later explicit one
stays explicit, including one reintroduced by an older writer: the stored
marker cannot distinguish its provenance. The trigger cap stays independent.

The shared mkdir lock retries every occupied-directory window within the
caller's retry deadline, including owner-file publication and removal. It never
removes a contender's lock or steals from a live, dead or unreadable owner;
persistent contention ends in the caller's existing busy error.

Spawn compensation returns its diagnostic and a structural uncertainty flag;
only an incomplete result marks the original error's `details.unconfirmed`.
CLI wrappers preserve that field, and the operation runner promotes a provider's
literal true marker while retaining the nested envelope. Message-based consumers
remain during the additive producer migration; do not replace stage evidence
with a substring check or infer uncertainty from a retained home alone.

The schedule child supervisor installs SIGINT/SIGTERM/SIGHUP handlers before
launch and removes them on settlement. All catchable shutdown signals share
its idempotent TERM/KILL path; the first stop cause is retained. The private
receipt records interruption independently of both the first stop cause and
the direct child's observed exit, so a signal during overflow cleanup still
keeps an otherwise valid envelope unconfirmed. Group probes
start at leader exit; an observed-empty group is permanently excluded from
later probes/signals. Polling cannot eliminate the gap before observation or
prove away PID reuse. Escaped sessions are outside the owned group, and
SIGKILL/OOM or unrecoverable supervisor death cannot be cleaned up by handlers;
a missing receipt supplies no child-exit evidence and cannot release a slot.

Session input keeps terminal operations separate from display observation.
The pre-Enter budget starts at paste completion, before best-effort buffer
cleanup; post-Enter observation starts after the single key command returns.
Both use a monotonic clock, clip sleeps and read-only capture subprocess
budgets, and stop observing on failure or exhaustion. Capture subprocesses use
SIGKILL on timeout so an ignored TERM cannot extend a probe; terminal command
timeouts/errors are unchanged. Screen comparison can set only the observational
`verified` boolean, never send another key or report terminal failure. Tests
use inert command runners and clocks; they do not qualify broker delivery or
harness acceptance.

Schedule doctor diagnostics read saved definitions, run state, snapshot and
validated local configuration without constructing a live placement context.
Only a persisted attempt is described as blocking another run; an unknown last
observation may be refreshed by a later eligible tick. Workspace exclusions
can be diagnosed offline, but owner authorization cannot be established there,
so the remedy remains diagnostic prose. This does not add retained-state
reconciliation outside current placement or mutate attempts and locks.

The kernel is runtime-neutral: nothing in `lib/` depends on a harness or on
a provider. Provider behaviour lives in capabilities; the kernel supplies
their contracts ([layers](layers.md)).

### Remote diagnostic display

`lib/remote.mjs` exposes explicit display entry points for direct module callers:

- `displayRepoRef(value, { pinned = false, rejectedValue = false } = {})`
  renders selected reference values, including nested keys and values. For a
  pinned source, `pinned: true` splits the complete `<ref>@<commit>` value;
  `pinned: { ref, commit }` supplies its original components. Both forms
  require a recognised reference and a 40-hex commit, with no plain fallback.
- `displayDiagnosticText(value, source = null, { fragment = false, refusal = false, substitute = true, rejectedValue = false } = {})`
  renders kernel-authored diagnostic prose using its selected original source
  values, including fragments and refusal explanations.
- `scrubGitLine(line, url = null)` handles Git-authored lines through the
  [whole-line disclosure rule](workspaces.md#repository-references-in-diagnostics)
  before control and length formatting.

All three delegate to the existing private `renderRemoteDisplay`; construction
and withholding policy live there. Each public entry fixes its context and
extracts only its named options, so an extra option cannot select Git-line
handling through either of the other entry points. These exports are for
internal/direct-module callers: `lib/remote.mjs` is not in the package export
map. Call sites choose the entry matching the origin of the value or prose;
there is no implicit-context `redactUrl` export or compatibility shim.

### The remote read path

Every CLI command owns one read session (`createReadSession` in
`remote.mjs`, carried to every remote call as `remoteOptions.session`; the
CLI closes it when the command ends). A library caller without a session
gets the plain per-call behaviour. Within a session:

- a HEAD observation speaks protocol v0 when the operator has not pinned
  `protocol.version` (`git config --get`, read once per command): the whole
  ref advertisement in one round trip, resolved exactly as v2's filtered
  answer. `V0_ADVERTISEMENT_BUDGET` (4 MiB, git's `maxBuffer`) bounds what
  is kept, not the transfer: git reads the whole advertisement before it
  prints a ref, so a remote over budget costs its advertisement once, then
  git is killed, the remote observed again under v2 and recorded. A v0
  timeout stays today's error (no retry) and is recorded too, unless the
  session's `deadline` cut that read's timeout (the deadline, not the remote,
  may have ended it). The
  v0 read and its `protocol.version` check go through `sessionExec` like every
  other git call. The record is
  `<cacheRoot>/.ls-remote/<sha256(key)>.<reason>.json`, `{ protocol: "v2",
  reason: "overflow" | "timeout", recordedAt }`, one file per reason (an
  in-flight timeout never replaces an overflow), written atomically with no lock;
  `overflow` is permanent, `timeout` expires after 7 days, and an unreadable,
  corrupt or expired record is no record (v0 is tried). Another v0 failure
  that is not final (auth, not-found, cache, an abort) is retried once under
  v2. Each is a session notice. The v2 argv (`lsRemoteArgs`) stays the
  observation's identity: records and memo keys do not depend on the
  protocol;
- a head is observed once per (cache repo, ref), and a commit peeled once; at
  most eight observations run at once (`OBSERVE_LIMIT`), each holding its slot
  for all its git work (the `ls-remote` and the fetch of the commit it names,
  or the fetch of a reused record's commit);
- a whole-workspace discovery prefetches its members' heads together with the
  host's (`prefetchMembers` in `workspace.mjs`): the member list comes from the
  host's last observation record and the parsed `workspace` entry at that
  commit, never from a git process, and the answer still uses the list at the
  host commit observed now. A prefetched failure is adopted by the member's own
  observation, not retried in the command. A prefetch no caller adopts (the
  host could not be observed, or the member was dropped since) is abandoned:
  one still queued runs no git. `observeWorkspace` alone (the `teams` reads,
  `inspect --home`) never prefetches;
- closing the session (the end of the command, or `process.exit`) rejects
  every queued observation and aborts every git child still running for it
  (the session's `AbortSignal` rides every `runGit`). `runGit` starts git as
  its own process group, so a timeout, an output overflow or an abort kills
  git's ssh or remote helper with it; before a capability
  command runs its provider, the CLI ends the idle batch readers
  (`closeBatches`);
- a commit's tree is listed once (`git ls-tree -r -t -l`, bounded by
  `TREE_INDEX_BUDGET`; anything odd falls back to the per-path reads), and
  blobs come from one `git cat-file --batch` reader per cache repo (at most
  12 open, ended through `process-group.mjs` on timeout and at close);
  `fetchRemoteTree` copies a module through it too, once `ensureBlobs` has
  fetched what was missing (git re-reads its packs on a miss, so a reader
  opened earlier finds the new blobs; one still missing answers `missing`,
  never a fetch), with what is left of `TREE_BUDGET` as each read's bound;
  a blob the reader answers `missing` or over its bound is read once more
  alone, so the error is the one a copy without a session gives. A
  command that ends normally awaits the close, so its readers are reaped
  before it exits; a `process.exit` (every refusal) ends them in the
  exit hook (`closeNow`), and the system reaps them once the process is gone;
- a session may have a `deadline` (`READ_REMOTE_BUDGET_MS`, 12 s after it
  starts): the CLI gives one to `status` and `workspace status` only
  (`read-call.mjs` `readBudget`; `OATS_READ_REMOTE_BUDGET_MS` is a test and ops override,
  not a contract). Every
  remote step then gets what is left of it instead of its own default: each
  git call's timeout (`sessionExec`: ls-remote, fetch, ls-tree, the cache's
  plumbing; none starts once nothing is left), the git version probe
  (`readVersion`), the batch readers' answers, the cache write lock's wait,
  the half-initialised cache's wait and the lock-race backoff. What the
  deadline ends is a `timeout` (a peel or version it ended is never read as a
  missing commit or an older git), so an unread member degrades as any
  unreadable one. A peel is judged by git's own result (`timedOut`), never by
  the wall clock: git's timer can fire a moment before `Date.now()` reaches the
  deadline. A cut wait never changes what it judges: past the deadline
  no lock is taken or reclaimed (live, stale or unreadable), and a cache
  directory waited for less than in full is not taken for a crash's leftover;
- every git child is ended with SIGTERM first and SIGKILL only after a
  grace (`terminateGroup`): git removes its own lock files on SIGTERM, and
  a git killed outright leaves one that blocks every later write. The
  SIGKILL goes to the whole group even when git itself has exited, so a
  descendant that ignores SIGTERM (ssh, a remote helper) still ends; but
  never to a group seen empty, whose id may already lead an unrelated
  group. Until git's `close` (`watchGroup`), a member holding its pipes
  keeps the id ours; after it, the group is probed every 50 ms through the
  grace (no pid is allocated while it is a live group's id): empty, and it
  is never signalled again. git's pipes are drained on a kill, never
  destroyed, so `close` keeps waiting for a pipe-holding descendant. The exit
  hook cannot wait for a timer, so it waits a bounded 200 ms synchronously
  (`reapOnExit`);
- discovery reads members eight at a time (`DISCOVERY_CONCURRENCY`) with
  serial results: declaration order, the first failure in that order. The
  observations and the member reads are two pools, so a discovery runs at
  most sixteen short-lived git processes at once (eight of them fetches at
  most), plus up to twelve cat-file readers: twenty-eight git processes. One
  shared pool would deadlock: a member read holding a slot waits on its
  member's observation, which needs a slot of its own.

The cache repos are partial: a commit is fetched with all its trees and
only the blobs up to `SMALL_BLOB_LIMIT` (64 KiB), which covers every file
discovery reads, so listings and discovery stay local after one fetch. A
read that needs a larger blob, or a `fetchRemoteTree` of a module, fetches
the missing blobs first in one fetch by id (`ensureBlobs`), then applies the
budgets to their real sizes before anything is written. git never fetches a
blob lazily (`GIT_NO_LAZY_FETCH=1`, and no url is stored in the cache: each
fetch passes it with `-c remote.origin.url=`). A server without partial
fetches gets whole trees; the cache records that (`oats.fetch = full` in its
config) and the CLI prints the session's notice once, on stderr. Partial
caches need git 2.45 or later (`PARTIAL_FETCH_GIT`, the first git with
`GIT_NO_LAZY_FETCH`): only a successfully parsed version below that floor
authorizes a version-driven rebuild. With that older git every cache fetches
whole trees, a partial cache it meets is deleted and fetched again whole,
and the same notice says why. An existing full cache stays full even when a
later probe reports a modern git.

One private strict version probe owns the memo per `exec`: concurrent callers
share the in-flight probe, and a parsed success is retained. A rejection,
unparseable result, or waiter leaving on timeout/cancellation removes only
that probe's own memo entry, so a later call
can retry without an old failure evicting a newer probe. `gitVersion(exec,
opts)` wraps this same probe for compatibility, returning a version or `null`;
it never memoizes a failure as `null`. The cache read path's `readVersion`
uses the strict probe and maps failure through the existing
`E_REMOTE_UNREADABLE` classification. Unparseable output is `unknown`; a
probe's own `timedOut` remains `timeout` even before a session deadline.
Each waiter can leave on its own timeout or cancellation. The launching
caller supplies the shared Git process's timeout and signal: when those end
the probe, every remaining waiter receives that original failure, even with
time left on its own deadline. A later call retries; leaving a wait never
changes the outcome delivered to peers still awaiting that probe.
These refusals apply with or without a read session and preserve the
existing partial cache, its fetch mode and its commit pins; failure never
reaches the version comparison as an older git. Raw version stdout and
command arguments are not diagnostic text.

The fetch of a commit negotiates: git tells the server the commits the cache
holds (its pins), and the pack holds only what they lack, a few kilobytes for
a new head beside the last one. The server may then send an object as a delta
against one it takes the cache to hold, and the cache does not hold the blobs
its filter left out: git cannot complete that pack, may not fetch the missing
base on its own, and the fetch fails with words the kernel cannot classify.
`git fetch` cannot ask for a pack that is complete by itself while
negotiating, so `fetchCommit` makes a fetch that failed as `unknown` once
more without negotiation (`fetch.negotiationAlgorithm=noop`), which brings
the commit whole and is complete whatever the cache holds
(awebai/oats#1059). One second attempt, never a third, and never on git's
wording. git does not remove the pack file of a fetch that dies
(`objects/pack/tmp_pack_*`), and the cache runs no gc, so every fetch, under
the write lock, first removes the temporary files of the object store that
are older than the longest fetch (`temporaryStaleMs` in `lib/remote.mjs`
says what that is): `tmp_*` in `objects/pack`, in `objects` and
in its two-character directories, where git's own `prune` looks, and nowhere
behind a symbolic link. Age is the only rule, the one of a stale git lock
below and of `git prune`. A failed fetch's own pack is not removed at once,
because a file that appeared during a fetch cannot be told from one another
git is writing: an older kernel's fetch takes no write lock, and git names
the file itself.

A failed git call is classified from what it shows (`classifyRemoteFailure`):
our own timer's kill is `timeout`, another signal `killed`, a failed write of
the cache `cache`, and otherwise git's text decides, read without the object
ids it names. A text that shows nothing the kernel recognises is `unknown`,
never `network`. `gitLastLine` reads only stderr for an `unknown` failure:
empty or whitespace-only stderr supplies no line; an output overflow without
a stderr line supplies a kernel-owned budget notice. It does not substitute an error message; other
routes' existing error-message fallbacks are unchanged. A stderr line passes
through `scrubGitLine`, which delegates the
[whole-line disclosure rule](workspaces.md#repository-references-in-diagnostics)
to the renderer with the original line and original operation references before
formatting.
When disclosure is not proved safe, it returns the contract's fixed Git notice;
it does not try to recover a safe fragment. Classification and kernel-owned
reason text do not depend on whether Git's words can be shown.

Every write to a cache repo (its `git init`, config, fetches and pins) holds
the repo's cross-process write lock, `<cache>/.locks/<repo>.lock`
(`withCacheWriteLock`): an exclusive file holding `{pid, token, startedAt}`,
waited for while its holder lives (bounded by a whole fetch, then
`reason: "cache"` naming the pid), reclaimed when the holder is dead, and
released only by its owner. Reclaimers take a short guard,
`<lock>.reclaim`, and check under it that the lock is still the dead
record before removing it, so a reclaimer that paused cannot delete a
live process's new lock. A guard whose holder died is never removed
automatically (that removal would race the same way, with nothing left to
serialize it): every write refuses at once, `reason: "cache"` naming the
guard (`details.guard`), until a human removes it once no oats process is
running. Reads take no lock. A cache repo appears whole
(`git init` into a private directory, then a rename), so processes making
the first fetch of one remote all succeed. A git `*.lock` a write meets is
judged under that lock (`cacheGit`): older oats kernels take no write lock,
so it is retried briefly, then removed only when it is inside the cache
repo, a regular file and older than the longest fetch
(`GIT_FETCH_TIMEOUT_MS` plus a margin): a git killed mid-write. A removal
is said once as a warning. Anything else is `reason: "cache"` naming the
file and when it is safe to remove; so is any other local write failure
(a `FETCH_HEAD` git cannot open, a read-only or full disk), with git's own
words.

Nothing but the kernel runs git in a cache entry. What an entry is
(partial, with no url, pinned by its own refs, no blob fetched lazily)
holds only through the kernel's own commands, and a git command named for a
read still writes there: a `git fetch --dry-run` writes the objects it
receives, and takes no write lock.

Across commands, `memoAtCommit` keeps parsed reads under
`<cache>/.parsed/<kernel fingerprint>/`, keyed by (repo key, full commit,
item). The items: `workspace` (the workspace file), `membership` (a member's
backlink outcome), `enumerate` (a member's souls and capabilities),
`package-soul` and `external-soul` (one soul file each; their error handling
differs), `package-manifests` (a package's manifests), `list` (a skill
listing) and `tree-oids` (the tree ids of a set of directories). An entry is only ever a pure function of those bytes and this kernel's
code, never local state and never a transient error; it is written
atomically, a corrupt one is a miss, and `pruneStores` bounds the store
(`PARSED_LIMITS`, least recently used first). `--max-age` adds the observation
store `<cache>/.observed/` ([Observation reuse](desktop-cli-api.md#observation-reuse-feature-observe-max-age-oats-0311)):
one record per (repo key, ref args, url digest), so two spellings of one repo
keep a record each; the url itself is never written. Beside it,
`<cache>/.observed-facts/` holds the remote facts that are not heads
(`factObservation`): today the `gh` login `workspace status` places automations
with for display ([the `gh` login, display only](desktop-cli-api.md#the-gh-login-display-only)).
A record is named by the digest of its fact's context (`ghLoginParts` in
`automations.mjs`: never a token value) and holds only the answer and when it
was observed; only `workspace-read.mjs` passes the reuse to `ghLogin` (its
`lookup`, with the display's 5 s wait), so a tick, a poll or a run always asks
`gh` live. `pruneStores` bounds both stores alike. Adding a cached item
means choosing an item name unique to its producer (the item string its
call site passes to `memoAtCommit`, or to `atCommit` in `workspace.mjs`) and
adding it to `test/parsed-cache.test.mjs`; `test/read-path-scale.test.mjs` pins the member
scaling by call count.

## Tests and gates

| command | what it checks |
|---|---|
| `npm test` | every suite under `test/` (`node --test`), through `scripts/run-tests.mjs`, which also fails the run when an `oats: warning:` line is left in a test file's output, or a test file leaves something in its temporary directory |
| `npm run test:session` | the suites that have followed a variable of the session that runs them, with every such variable set to a value that cannot work (`scripts/test-session-inheritance.mjs`) |
| `npm run check` | syntax of every shipped file |
| `npm run check:pi` | the pi adapter's TypeScript |
| `npm run validate` | the JSON schemas, the example manifests and configs, every local link and anchor in the public docs (a release-notes entry under `docs/release-notes/next/` has its links read from `docs/release-notes/`, where its text is moved), the repository's own `oats-workspace.yaml` and `package-catalog.json` read by the kernel's readers, and no unresolved merge-conflict marker in a tracked text file (`scripts/check-workspace-files.mjs`) |
| `npm run pack:check` | an `npm pack` dry run of both packages: nothing missing, nothing leaked |
| `npm run smoke:tarball` | installs the packed tarballs outside the checkout and exercises them |

Locally, run the suites your change affects, plus `validate` and `check`; run
`smoke:tarball` when you change the smoke script or packaging. Pull-request CI
runs the full suite (sharded), the Desktop suite again with only Desktop
dependencies installed, `check`, `validate`, `pack:check` and the smoke test,
and is the gate. Tests use local bare repositories and fakes; none contacts
GitHub, aweb, Jira or Linear.

### The TUI's tests on macOS

A pull request that touches `packages/tui/`, `packages/client/`, a
`test/tui-*.test.mjs` file or the workflow itself also runs
[`tui-macos.yml`](../.github/workflows/tui-macos.yml): every TUI test file,
`packages/tui/test/*.test.mjs` and `test/tui-*.test.mjs`, one file at a time
and each test within five minutes, on `macos-15` with tmux installed, in about
five minutes. Its last step fails the run if a test left a tmux server on the
default `oats` socket, as a hand-started run checks after each file; it does
not give each file a process group of its own, as a hand-started run does. The
TUI reads tables keyed by platform (the shared keymap's macOS chords) and
drives macOS's own tmux, whose output differs from Linux's, and Linux CI sees
neither ([#1608](https://github.com/awebai/oats/issues/1608),
[#1613](https://github.com/awebai/oats/issues/1613)). It runs at pull-request
time, not on the tag's macOS legs: a failure found on the tag costs a version,
and `release.yml` holds the publishing rights, so a TUI flake there would hold
a publication (the release lane's call, 2026-10-27).

The paths are the TUI's own. A change the TUI depends on outside them (`lib/`,
`bin/`, `test/helpers/`, `package.json`, `package-lock.json`) starts no run,
and nothing runs on a push to `main`: such a change wants hand-started macOS
runs of the TUI's files, at most ten files a run
([Named test runs](named-test-runs.md)).

The job is not part of the gate above. A path filter that skips the workflow
reports no check, so a required check would hold every pull request that does
not touch the TUI. Its run on the pull request is that pull request's macOS
evidence. `test/tui-macos-workflow.test.mjs` pins its terms: the one trigger
and its paths, the read-only token, no secret, no artifact or cache, tmux, a
command that runs every TUI test file, and the leak check. Like the release's
workflows, it names its actions by commit (`test/workflow-no-cache.test.mjs`).

**Test output is pristine.** A warning that a test expects is captured and
asserted by the test, or by its fixture, and never left in the output: a line
nobody asserted is then one nobody expected. The root run holds the rule
(awebai/oats#910). Beside the reporter a person reads, which stays the one
`node --test` would pick, `scripts/run-tests.mjs` gives the run a second
reporter (`scripts/test-warnings-reporter.mjs`) that reads what each test file
wrote to its stderr and stdout and records every line that holds
`oats: warning:`. When there is one the run fails, even if every test passed,
and names each file, its count and the lines. A file's output is what its
worker wrote and what a child wrote that has the worker's stderr or stdout as
its own; a line a child wrote into a pipe the test reads is the test's, and
does not count. `test/unasserted-warnings.test.mjs` pins the rule with nested
runs.

**A test file leaves nothing behind.** Where a test makes a directory, it
registers the removal there (`t.after`, or a list the file empties when it has
ended), so a test that fails or times out removes it too; and a fixture is
ended, not only removed (`v2Deployment({ t })`, below). A file whose setup is
shared by its tests does that setup in a `test.before` hook, not at its top
level: a file that throws while it loads runs no hook, `test.after` included,
so a step that failed would leave what the steps before it made
(test/tui-acts.test.mjs). On a development host
the leftovers of runs that passed once used up the inodes of the temporary
file system, and every test that makes a directory then failed with "no
space", whatever the change under test (awebai/oats#1025). The root run holds
the rule:

- `scripts/run-tests.mjs` makes one directory for the run, and each test
  file's process is preloaded with `scripts/test-file-tmpdir.mjs`, which gives
  the file a directory of its own inside it: as `TMPDIR`, and as
  `TMUX_TMPDIR`, which is tmux's default place. A tmux client that runs with
  no `TMUX_TMPDIR` of a fixture makes its socket directory there, where the
  run sees it, instead of reaching the host's default server. `TMUX` is not
  changed: a client that names no server (no `-L` or `-S`) and inherits
  `TMUX`, as in a run from a session inside tmux, still uses that session's
  server and makes nothing the run sees. The run names its directory to the
  preload in `OATS_TEST_RUN_DIR`, and the preload takes that variable out of
  the file's environment before any code of the file runs. No test sees it,
  nor any process a test starts.
- The preload also gives each file an `OATS_HOME_DIR` of its own,
  `<n>.oats-home` beside its directory, holding a deployments list whose
  `~/Agents` import is marked done (awebai/oats#1390). Any kernel command run
  in a deployment adds that deployment to this computer's list, so a test
  that runs the CLI with the environment it was given never writes the
  person's `~/.oats`, nor reads their `~/Agents`. A test that names an
  `OATS_HOME_DIR` of its own beside the person's `HOME` seeds the same marker
  (`test/helpers/host-fixture.mjs` `deploymentsImported`); a fixture with a
  `HOME` of its own needs nothing. When the run has ended, a row added to the
  person's list during the run under a temporary directory fails the run,
  naming it.
- The auto-add never lists a deployment under a temporary directory
  (awebai/oats#1397), so a test that needs it to list one makes its
  deployments outside them: `test/helpers/outside-temporary.mjs`
  `outsideTemporaryBase(t)`, a 0700 base in `/var/tmp` named
  `oats-deployments-test-<run>.<n>-…` and removed when the test ends. Where
  `/var/tmp` is missing, not writable or itself temporary, such a test skips,
  saying why; it never falls back to `/tmp`. The run reads `/var/tmp` for its
  own bases when it has ended: one still there is left behind, named for its
  file and removed.
- When the run has ended it reads each file's directory. If one is not empty
  the run fails, even if every test passed, and names each file and what it
  left.
- One name is not counted, by its exact name: `node-compile-cache`. Node makes
  it under the temporary directory when a tool a test starts asks for a
  compile cache (npm does), so under the root run it is made in the file's
  own directory and goes with the run's. It is Node's, not something the file
  left. A developer's shared cache, the one in the platform's temporary
  directory, is neither used nor removed by a root run; a file run alone uses
  it as before, and no test deletes it. The run's processes do not inherit
  `NODE_COMPILE_CACHE` either: with a developer's set, no process of the run
  writes into that cache.
- The run's directory is removed when the run has ended, whatever was left in
  it. A run that is killed leaves that one directory: `ot-*` under the
  temporary directory, or under `/tmp` when that path is longer than 20
  characters.
- A file's directory, `<parent>/ot-XXXXXX/<n>`, takes from a socket's path
  what `/tmp` alone did not. ssh binds a control socket at
  `<OATS_HOME_DIR>/ssh/<40 hex>` plus a 17-byte suffix, in 104 bytes: 86 for
  the path. A fixture whose `OATS_HOME_DIR` holds it keeps it short: a
  5-character prefix and `<base>/h` (`o-up-`) come to 85 bytes when the
  run's parent resolves to at most 12 characters, as `/tmp` does on Linux
  and on macOS (`/private/tmp`), with up to 999 files. Longer, the kernel
  warns that the path is too long and runs ssh without connection reuse,
  which fails the run as any unasserted warning does: run the suite with a
  `TMPDIR` of `/tmp` then.
- The run sees what is made under the file's temporary directory: by the
  file's process, by a process it starts with that environment, and by the
  fixture helpers (`fixtureBase` and `privateTmuxTmpdir`, below), in a
  process the test started with `inheritedEnv()` too. It does not see what a
  process makes when a test built its environment without `TMPDIR`.

`test/left-behind.test.mjs` pins the rule with nested runs.

Desktop's standalone tests (`cd packages/desktop && npm ci && npm test`) must
load with only Desktop dependencies installed. The release builds Desktop that
way: its `desktop-build` job installs and tests inside `packages/desktop` and
never installs the root. The sharded suite installs the root first, so a
Desktop test that reaches a root-only dependency passes there and would fail
only at a tag. Pull-request CI therefore has a `desktop-standalone` job that
runs the same `npm ci` and `npm test` inside `packages/desktop` with no root
install, and the gate requires it. `test/continuous-integration.test.mjs` pins
that job against `desktop-build`: change how one installs or tests Desktop and
the other changes with it.

The Desktop suite runs in the root shards and in `desktop-standalone`, and
`desktop-standalone` is its release gate. `test/release-workflow.test.mjs` no
longer runs it nested inside a root shard: it checks that the Desktop scripts
the release invokes exist. `test/helpers/nested-test-failure.mjs` remains the
way to build a readable failure message from a nested `node --test` run's
output. The message names the failing tests (TAP or spec reporter) with their
location and error, then gives bounded stdout and stderr tails, and its size
is capped. It is built only when the run failed, and it never throws: if
reading the failures fails, the message says so and still carries the tails.

A test never races the wall clock for a window between two steps of the
kernel. Where an answer needs a second writer at an exact moment (an entry
that vanishes between a walk's listing and its read), the test runs the CLI
as a child held at one named `node:fs` call with
`test/helpers/fs-gate-preload.mjs` (`startGated`), does what the second writer
does, and releases it. A gate that pauses changes no argument and no result.

A test never fills a file system, and never waits for one to be full. Where an
answer needs a write to fail with a code no file shape gives on every host
(`ENOSPC`), the same helper makes one named `node:fs` call of that child fail
with it (a gate's `throws`; `runFaulted` runs a child whose gates all throw).
A shape that does fail by itself, a directory that is not writable, is made
with mode bits instead and skipped for root.

Cross-package tests that import both the kernel and Desktop belong under root
`test/`; install dependencies at the root and in `packages/desktop` before
running those tests. The schedule
round-trip case is `node --test test/desktop-schedule-roundtrip.integration.mjs`.
The root runner includes this file with its existing Desktop dependency group.
With only root dependencies installed, it omits both Desktop suites and this
integration case and reports that coverage gap before and after the run.

Tests pin behaviour, so a change that alters behaviour changes its test in the
same commit. Never weaken an assertion to make a change pass.

Since Git 2.47, a commit or fetch starts `git maintenance run --auto
--detach`, a daemon that outlives the command. On a loaded CI runner it can
still be repacking into a repository while the test's cleanup removes it,
which fails with `ENOTEMPTY` (awebai/oats#451). So:

- The shared fixture's repositories (`test/helpers/v2-deployment.mjs`: the
  bare remote, the seed and the member clone) never run it. Each sets
  `maintenance.auto=false` in its own config, which covers every git run in
  it, a test's raw `execFileSync("git", …)` and the kernel's included.
- A test that runs git itself goes through the fixture's `git()` helper,
  which disables it per command, or sets `maintenance.auto=false` in a
  repository it creates.
- The kernel's remote cache passes `-c maintenance.auto=false` on every git
  it runs there.

Never paper over such a race with a retry around the cleanup.

A process that a test kills can leave such a writer too. Killing a process
that starts processes of its own ends that one alone: a child it had just
started goes on by itself and writes where it was told to after its parent has
gone, and it has not run a line yet, so it has announced itself nowhere. The
Desktop server's tests are the case: the server runs the CLI, and a fake CLI
writes its log in the test's directory. Such a test starts the process with
`startGroup` and closes it with `closeGroup`
(`test/helpers/process-group.mjs`):

- `startGroup` starts it as `spawn` does, as the leader of a process group of
  its own, which holds whatever it starts.
- `closeGroup` kills that one process and waits until its group, that process
  among it, is empty. The bound, 30 s, covers the whole close from its start:
  a group that outlives it fails the test and names every process that is
  left, the killed one too if it still runs. Only then does the test remove
  what they worked in.
- A group of its own is not in the terminal's foreground group, so an
  interrupt of the test's process does not reach it. The helper passes it on:
  on `SIGINT`, `SIGTERM` or `SIGHUP` it kills every group that process
  started, whole, and then the signal ends the process as it would have. A
  test process killed with `SIGKILL` passes nothing on: what it started stays,
  as any child of a process killed that way does.

`test/process-group.test.mjs` pins the three.

A test never reaches the operator's tmux. The kernel creates sessions on the
server named `oats` (`tmux -L oats`), which tmux resolves under `TMUX_TMPDIR`,
and acts on every existing session through its recorded socket
([execution-targets.md](execution-targets.md#the-oats-tmux-server)). So:

- A test that runs real tmux installs `isolateSessionEnvironment(base)`
  (`test/helpers/host-fixture.mjs`). It owns a private, short `TMUX_TMPDIR`
  (socket paths are limited to about 104 bytes) and puts a `tmux` wrapper
  first on `PATH` that admits only `-L oats` and `-S` of a socket inside the
  fixture, with no user configuration unless the test asks for it;
  `oatsSocket()` is the socket `-L oats` resolves to there. Its restore
  function kills that server, by socket.
- A test may instead start its own server on a private socket it creates
  under the temporary directory (`tmux -S <socket>`) and kill that server by
  its socket, as the older live tests in `test/desktop-tmux-target.test.mjs`
  (base-index, wheel, drag, Slice G) do.
- The shared fixture (`test/helpers/v2-deployment.mjs`) gives every command
  it runs a private `TMUX_TMPDIR` too, so a test with a fake `tmux` on `PATH`
  cannot reach a real server either. A fake answers what the kernel asks:
  `list-sessions`, `new-session` (it prints `<socket>\t<window id>`),
  `list-windows`, `new-window` (a window id) and `set-option`.
- A server a test starts is killed by its socket, never by name and never
  with a bare `tmux kill-server`.
- A test never reaches the host's `systemd-run` (#915). A Linux creator
  inside a systemd service or a user-manager scope starts the server through
  the system's own `systemd-run`, and every launch on the unified hierarchy
  probes it for the agent's scope, found by absolute path, not on `PATH`, so
  a fake-free `PATH` does not stop it. The fixtures (`isolateSessionEnvironment`,
  `fixtureEnv`) therefore set `OATS_TEST_CGROUP` to a scope outside the user
  manager, never a service, whatever runs the suite, and
  `OATS_TEST_SYSTEM_TOOL_DIRS` to the fixture's own `fixture-system-tools`:
  the host's `env` and `true`, and a `systemd-run` that runs what follows
  `--` in its own process. So every fixture launch is wrapped, and passes
  through that fake, never the host's user manager. A test of a scope sets
  its own. Three test-only seams select where the kernel judges itself and
  which `systemd-run` it runs:
  - `OATS_TEST_CGROUP`: the text of a `/proc/self/cgroup`, judged as Linux
    booted with systemd;
  - `OATS_TEST_SYSTEMD_BOOTED`: `1` or `0`, in place of whether
    `/run/systemd/system` is a directory (sd_booted): `0` is a Linux host
    without systemd, where no agent scope is judged;
  - `OATS_TEST_SYSTEM_TOOL_DIRS`: absolute directories separated by `:`, in
    place of `/usr/bin:/bin`. Any other value means no system tool, never a
    `PATH` lookup.

  All three are reserved launch names (a launch configuration cannot set them),
  are removed from a server's environment, and are stripped from the tick's
  children like every reserved name. In process, `io.cgroup`, `io.platform`,
  `io.invocationId`, `io.systemdBooted` and `io.systemToolDirs` do the same for
  `ensureOatsTmuxSession`, and `agentScope` takes `io.scopeProbe` in place
  of the real probe. A start given an `io` with no `scopeProbe` judges no
  agent scope at all (its tmux is a test's). The one test that reaches the
  host's user manager (`test/tmux-server-scope.test.mjs`, "for real") runs
  only where the real probe passes, and says why it skipped otherwise.
- A test that needs a terminal (an attached tmux client, a key press) runs
  the command in a pane of a second private server and types at that pane
  with `send-keys`; the pane's shell records the exit status
  (`test/session-attach-detach-key.test.mjs`). A mouse report is sent as the
  bytes a terminal sends (`send-keys -l`). A pane program that must show the
  keys it reads puts its terminal in raw mode first: in cooked mode a control
  byte is a signal or an edit, not input. A signal to the command's process
  group (what a pty hang-up or a C-c delivers) needs the command to be a group
  of its own: the pane's script starts `trap : INT; set -m`, so the shell
  survives to record the status (bash would otherwise end itself after a job
  that INT ended). A `tmux` first on the command's `PATH` times the signal
  against one of the command's tmux calls; it finds the group with
  `ps -o pgid= -p $PPID`.
- A test of a full-screen program (`oats tui`) uses a pane of a private
  server as its terminal (`test/tui-terminal.test.mjs`): the real CLI is typed
  at an interactive shell in the pane, keys go in with `send-keys`, the screen
  is read with `capture-pane`, and what the program did to the terminal is
  read from the pane's flags (`#{alternate_on}`, `#{cursor_flag}`,
  `#{wrap_flag}`) and from `stty -g`. Every wait is on what the pane shows,
  with a message that names it. A process is signalled by the pid it wrote
  itself, never by name or command line: other agents' processes run on the
  same machine.

Nor does a test depend on where or how the suite runs:

- A worker whose working directory is inside an instance home (a developer
  agent running the suite from its work tree) is that instance to the
  kernel. `isolateSessionEnvironment` leaves it; a fixture that builds its
  environment itself calls `leaveEnclosingInstance(base)` and moves back
  when it is done.
- `isolateSessionEnvironment` drops `CLAUDECODE`, which a worker inherits
  from a Claude Code session: a server the worker starts would hold it.
- An expected path is built on a canonical fixture base,
  `realpathSync(mkdtempSync(…))`: the platform's temporary directory can be
  a symlink (`/var` on macOS), and the kernel builds the paths it reports on
  its working directory, which the OS gives as the physical path.
- A probe of the host that reads under `HOME` (the scheduler's installed
  unit) runs with the fixture's own `HOME`.
- A fixture the filesystem may not represent (a file name that is not valid
  UTF-8, which APFS refuses) is probed in the fixture directory and skipped
  with its reason only when refused; Linux CI runs it.

A kernel suite is green on Linux CI **and** on a Mac with a loaded schedule
unit, a live operator tmux server and Apple git, run from inside an instance
home. A pull request that could not be run there says so in its hand-over. The
suite's own prerequisites are Node ≥ 22.12 (the leftover check loads the kernel
with `require`), git ≥ 2.45, tmux, and lsof where `/proc` cannot be read
(awebai/oats#783, #625). The
helpers in `test/helpers/host-fixture.mjs` hold the host isolation, and the
shared fixture (`v2Deployment`) applies all of it, so a suite built on it
inherits it (awebai/oats#816):

- **A short base.** `fixtureBase(prefix)` makes the fixture directory under
  the platform's temporary directory, or under `/tmp` when that is longer than
  20 characters (macOS's `/private/var/folders/…/T/` is about 49), as its
  realpath, taken once. Under the root run the temporary directory is the
  test file's own (above), and is used whatever its length, so that nothing a
  fixture makes is outside what the run reads; the run keeps it short. The
  helper knows it by what the runner makes (`ot-XXXXXX/<n>`, with the file
  `<n>.file` beside it) and by no variable, so a process a test starts with
  `inheritedEnv()` uses it too.
- **Names and paths sized from the base.** `nameOfLength(base, n)` (a file
  name or branch segment) and `pathOfLength(base, n)` (an absolute path under
  the base, `n` characters in all) are capped below NAME_MAX and PATH_MAX of
  the platform (255/1024 on macOS, 255/4096 on Linux), measured from the
  actual base. A "too long" test then exercises the kernel's bound, never the
  filesystem's.
- **An explicit environment for every child.** `fixtureEnv(base)` is what
  every child the fixture starts gets, and `fx.inEnv` applies the same rules
  to the test process for an in-process kernel call. `fx.inEnv` and
  `inFixture` set the names on the real `process.env` and put back exactly
  what was there (`forceEnvironment` in `test/helpers/v2-deployment.mjs`),
  never by assigning another object to `process.env`: a child the kernel
  starts with no `env` option gets a replaced object on some Node versions
  only (not from v26.11.0). Calls of one fixture may nest or overlap; a
  call of another fixture while one is in flight is refused. A test that
  holds one environment for its whole length saves `{ ...process.env }`, sets
  names on the real one and gives the saved one back with
  `setProcessEnvironment` when it ends; everything else goes through
  `fx.inEnv`. `test/fixture-real-environment.test.mjs` refuses an assignment
  to `process.env` in any test script. The fixture's
  environment sets `HOME` and the XDG base directories under the base, and
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_TERMINAL_PROMPT=0`, so no host git
  configuration or credential helper is read. It removes every `*_PROXY`,
  `CLAUDECODE` and git configuration passed through the environment. PATH
  starts with `launchctl` and `systemctl` stubs that answer as a service
  manager with nothing loaded. A test that needs another answer puts its own
  stub ahead of them.

  A fixture also never inherits the session that runs the suite. A developer
  agent runs it from its own session, which selects a harness account
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`), has a display
  and a tmux pane (`DISPLAY`, `TMUX`, `TMUX_PANE`) and is an instance (every
  `OATS_*` and `AWEB_*`, and the legacy `PI_AGENT*`); CI's shards have none of
  these, and the kernel reads several of them by design. One definition,
  `SESSION_VARIABLES` in `test/helpers/host-fixture.mjs`, names them, and one
  rule applies it: a helper leaves a session variable out while it still has
  the value the worker started with (the helper module is evaluated before
  any code of the test file that imports it, and keeps that environment), and
  keeps it once a test has set it. So a test that needs one sets it itself, in
  `process.env` before the fixture call or as `extra`, and the fixture's own
  (`OATS_HOME_DIR`, `OATS_TEST_CGROUP`, `OATS_TEST_LOGIN_SHELL`) are kept the
  same way. A test that sets a session variable to the very value the session
  has is taken for the session's, and the variable is dropped; no test does
  today. Every helper that builds an environment starts from
  `inheritedEnv()` or removes with `dropInherited(env)`; none has a list of
  names of its own, and a test that builds an environment itself starts from
  `inheritedEnv()` too. A helper that starts a child for a caller who gives no
  `env` (`startGated` and `runFaulted` in `test/helpers/fs-gate-preload.mjs`)
  gives it `inheritedEnv()`. `npm run test:session`
  (`scripts/test-session-inheritance.mjs`) is the check: it runs the suites
  that have followed a session variable with every variable a session has set
  to a value that cannot work, the names read from the helper's definition
  (its legacy names, which no session has, are dropped and not set). Give it a
  test file to run that file alone, and a flag for `node --test` with its
  value in the same argument (`--test-name-pattern=…`): it refuses a bare flag
  and any other argument, so it never starts `node --test` without naming the
  files.
  Pull-request CI runs it as the
  `session-inheritance` job, which the gate requires
  (`test/continuous-integration.test.mjs` pins both), and
  `test/session-inheritance.test.mjs` pins the rule helper by helper.
- **The same rules under real tmux.** `isolateSessionEnvironment` applies the
  same git, XDG and proxy rules, and removes the session's variables, by the
  same definition, from the worker itself: a tmux server holds the environment
  of the client that started it, so a server the worker starts, through the
  kernel or with its own tmux call, would otherwise carry the runner's display,
  pane and instance to the kernel that reads it back. Its PATH stays its own
  small set of tools, so no host service manager is reachable at all.
- **The fixture's expected warning.** A fixture's login environment cannot be
  read, by construction: its `HOME` is not the user's and its login shell
  (`OATS_TEST_LOGIN_SHELL`) does not exist. So where the kernel plans to start
  the fixture's tmux server it says, in one line on the worker's stderr, that
  it could not read the login environment and falls back. The fixture owns
  that line (`expectLoginFallback` in `test/helpers/host-fixture.mjs`). It
  takes the line out of the output only when the whole write is exactly the
  sentence the kernel writes for the fixture's reason, and only while the
  fixture's premise holds at that moment; any other line stays in the output
  and fails the root run. Every capture also asserts something that can fail:
  - `fx.inEnv`, for one kernel call: a server that appeared under the
    fixture's `TMUX_TMPDIR` during the call with no line fails the call.
    Nothing is asserted for a call in which the test replaced
    `process.stderr.write` itself: the test holds the line then, and asserts
    it. A child that plans the start writes the line on its own stderr: a
    test starts such a child outside the call, and where the kernel call
    itself launches through a child (a tick that runs `oats spawn`) the test
    holds stderr around that call and asserts what the worker wrote.
  - `isolateSessionEnvironment`, for as long as it is installed: a captured
    line with nothing ever created under its `TMUX_TMPDIR` fails its restore.
  - A test file whose fixture has no server to observe (a stand-in `tmux`)
    wraps each kernel call that plans a start and asserts the count the
    capture returns.

  The kernel writes the line where it plans a start, in the process that
  plans, so a socket shows neither who planned nor whether a start followed:
  no capture asserts that the warning comes. That is pinned by
  `test/login-environment.test.mjs`, `test/schedule-gone-server.test.mjs` and
  `test/fixture-expected-warning.test.mjs`, which start a real server and read
  the line.
- **No leftover processes.** The fixture's cleanup fails when a process still
  works in its base: `assertNoFixtureProcesses(base)`, over the kernel's own
  `processesInHome` (`/proc` on Linux, lsof where `/proc` is absent). It catches a hook's or a CLI's grandchild that
  outlived the test, once its parent has exited. The scan leaves out its caller
  and the caller's direct children, so a test's own forgotten child is not
  found here: that is the test's bug to fix. A process still exiting gets 2 s.
  Nothing is killed, the base is removed, and the failure names each pid and
  command. A test that leaves a process running on purpose (a group the kernel
  must not signal) ends it itself before that check, on failure too, through
  `fx.beforeCleanup(fn)`: the cleanup runs those synchronous functions first,
  in order, and still runs when one throws. Never end it with a later `t.after`: node:test
  runs `t.after` hooks in the order they were added, so a hook added after the
  fixture's runs after the check (`test/worktree-event.test.mjs`).
- **Cleanup even when a test fails.** Pass the test context,
  `v2Deployment({ t })`: the fixture registers its own cleanup with
  `t.after` when it is created, so a test that throws, rejects or times out
  still removes its base (awebai/oats#830). `fx.cleanup` does its work once,
  and later calls return quietly, so an explicit `fx.cleanup()` or a test's own
  `t.after(fx.cleanup)` can stay beside it. A fixture that fails while it is
  built removes its base itself. Removing the base is not ending the fixture:
  only `fx.cleanup` stops the fixture's tmux server, checks for leftover
  processes and removes the fixture's private `TMUX_TMPDIR`
  (`privateTmuxTmpdir()`), which is made beside the base and never inside it.
  So a fixture that was made and never ended leaves that directory, and the
  root run fails on it (awebai/oats#1025). A file that collects its fixtures
  ends each of them in the hook that used to remove their bases.
