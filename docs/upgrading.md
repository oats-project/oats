# Upgrading OATS on a host

This page opens with the upgrade to the latest version. The steps that are
the same for every release follow, then what each older release asks of a
host that comes from it.

## Upgrading to the latest version

The latest version is **OATS 0.69.12** ([release notes](release-notes/v0.69.12.md)).
The 0.69.12 Desktop accepts OATS CLIs `>=0.26.0 <0.70.0`.

**First, read the `## Upgrade` section of every release after yours, up to
0.69.12,** in the [release notes](release-notes/): it says what to do before
the CLI changes, and what else must change with it (the Desktop, another
tool, a package pin). [Coming from an older version](#coming-from-an-older-version)
names the releases that ask for more than the steps below. `oats version`
prints the version you have.

Then, on each host:

```sh
                                     # 0. where the Desktop is installed: Desktop 0.69.12 first
npm install -g @awebai/oats@0.69.12  # 1. the CLI
oats update                          # 2. in each deployment: the plan, then it asks before it runs
oats doctor                          # 3. in the same deployment
```

The Desktop's installers are the assets of the
[GitHub Release](https://github.com/awebai/oats/releases) of that version
([OATS Desktop](desktop.md#install)). Then restart the pi sessions that were
running: a session keeps the bridge it loaded when it started.
[The steps](#the-steps) says what each step does and why they come in this
order.

An agent with the oats.setup capability does this with you through its
`/oats-upgrade` skill. It reads this page and the release notes at the
latest release's tag, never the copy in the installed CLI, which describes
the version you are upgrading from.

## The steps

Upgrading OATS means three things, in this order, on each host, and one
before them where the Desktop is installed:

0. **The Desktop**, where it is installed: the new version's, before the CLI.
1. **The CLI** (`@awebai/oats`, the kernel).
2. **The pi bridge** (`@awebai/oats-pi`), in every pi folder the host's
   deployments launch pi with: `oats update`, in each deployment.
3. **A check of each deployment**: `oats doctor`.

The kernel and the bridge are published together, from one version tag, and
must be at the same version: a pi session with an older bridge runs old
extension code against a new kernel. A host that launches no pi instance has
no bridge, and step 2 has nothing to move.

The bridge loads the kernel that launched its pi instance, so a host that
runs the CLI from a checkout or a local install needs no global one for its
instances. A pi started outside any instance looks for a global install, an
`oats` on PATH that links to the kernel, or `OATS_PKG_ROOT`
([the bridge's README](../packages/pi/README.md)).

**A release's own steps are in its notes**, in its `## Upgrade` section.
This page is the part that is the same for every release.

**Why the Desktop goes first.** A Desktop accepts a CLI up to its own minor
version and refuses a newer one: with the CLI moved first, the Desktop that
is still running lists no instance until it is replaced. The new Desktop
accepts the older CLI in the meantime. The CLI can move by two commands, the
`npm install` and an `oats update` whose plan installs it: step 0 comes
before either.

**Package versions are a different thing.** `oats update` moves the CLI and
the bridge, never a package. A deployment's capabilities come from the
packages pinned in `oats-workspace.yaml`; change a pin, then run `oats sync`
([Packages](packages.md)). To move an existing stopped home to those locked
versions, follow [the package-module deploy step](#moving-existing-homes-to-locked-package-versions).

Run steps 2 and 3 in every deployment on the host, or name one from anywhere
with `oats update --dir <deployment>`.

In a terminal, `oats update` shows its plan and asks before it runs anything.
Without a terminal (a script, an agent's shell) it runs only with `--yes`.
`oats update --check` shows the plan and runs nothing.

`oats update` also does step 1: when npm lists a newer `@awebai/oats`, its
plan starts with that install, and the bridges move to that same version in
the same run. So where the Desktop is installed, step 0 comes before such an
`oats update` too: `oats update --check` shows whether the plan holds that
install, and runs nothing. When that install is of another minor or major
version, the plan says so in one line under its steps, whether or not a
Desktop is installed: `OATS Desktop refuses a CLI newer than its own minor
version: if you use it, install OATS Desktop <version> first.`

**`oats update` only moves forward.** It never installs an older CLI or an
older bridge than the one in place:

- **The CLI** is installed only when the version npm lists is newer than the
  installed one. When the installed CLI is ahead of it (a checkout, a build
  that is not published yet), the plan says so in one line and holds no step
  for the CLI.
- **The bridges** are brought to the version the CLI has after the run: the
  one npm lists when the CLI moves to it, the installed one otherwise. A
  bridge ahead of that version is left alone.

Versions are compared as semver, so a prerelease is below its release:
`0.53.0-rc.1` is ahead of `0.52.0` and behind `0.53.0`. Build metadata makes
no other version: a local build `0.53.0+build.1` is `0.53.0`, and nothing is
installed over it.

## Moving existing homes to locked package versions

After changing a package pin and running `oats sync`, move each existing home
explicitly. Run these from its deployment or a parent's home:

```sh
oats instance stop <instance>
oats instance upgrade <instance> --plan --json
oats instance upgrade <instance> --plan-revision <revision> --idempotency-key <key> --json
oats session start --home <absolute-home>
```

Read the plan before applying it. It lists every moving package module,
skill/inject/hook changes and provider adoption decisions, modules kept
because their package is no longer locked, and member drift for information.
A kept package module moves only by a respawn; `oats session start` and
`restart` say so in one warning that names each one.
One provider refusal refuses the whole move. A running or unreadable session
refuses with `E_SESSION_RUNNING`; stop it first. A stale plan returns
`E_PLAN_STALE` and a fresh plan to review.

Modules move whole, with skills, instructions and hooks recomposed from the
same sources as spawn. The soul body stays at its recorded commit, and member
modules stay unchanged. `oats status` drift clears after the move. Start and
restart keep the recorded copies; when they lag the lock they report drift
and print the stop/upgrade command.

Before commit, a failure restores composed home bytes only when no provider
apply hook succeeded and no outcome is uncertain. A non-zero result must be
observed and recorded in the same invocation; a killed or interrupted hook
can already have adopted host state even when no success was recorded. A hook
reporting failure is responsible for leaving no provider effects of its own.
After success or an uncertain outcome, failure records `partial` and moves
forward only: retry with the same `--idempotency-key` to finish pending work,
including an uncertain idempotent hook. A refusal on retry stays partial.
Start refuses with `E_UPGRADE_PARTIAL` until it finishes. If it cannot finish,
respawn the instance. Do not restore old modules by hand under adopted or
possibly adopted host registrations.

After swap and baseline, the receipt commits before publishing the success
event and cleaning staging.
If cleanup fails, the upgrade is complete and the same-key retry cleans up
only, without hooks or copies. Start is allowed with one warning naming that
retry. A new upgrade or undo plan refuses until cleanup finishes. Retirement
keeps its normal behavior; it does not finish upgrade cleanup.

The latest previous state is kept in `.oats/previous/<receipt>/`. To request
the reverse move, use `oats instance upgrade <instance> --undo --plan --json`,
then apply with `--undo --plan-revision <revision> --idempotency-key <key>`.
Undo verifies that copy and asks the version being restored to adopt the
current state through its own `upgrade` hook. A version lacking that hook
cannot be restored through undo; respawn instead. Each successful move replaces
the one previous state, and retirement carries it into recovery.

This act handles one local home at a time. A deployment loops over its homes;
it does not upgrade automatically or through `--server`.

## The move to the oats-project organisation

OATS is moving from the `awebai` GitHub organisation and npm scope to
`oats-project`, in stages. A GitHub transfer changes nothing a deployment
reads, because the old URLs redirect. A changed string does: the kernel
compares repository keys literally, and clients compare the CLI's npm name
literally. So a bridge release comes first.

**What the bridge does.** It makes the old and the new spelling of each moved
repository one repository ([Moved repositories](workspaces.md#moved-repositories)),
and it makes the kernel know the npm name it was installed under, so `oats
update` stays on that name and never crosses to the other. Clients and the pi
bridge accept both npm names.

**A deployment on the bridge behaves as it did before.** It emits the same
keys, uses the same cache directories and writes the same lock. Nothing asks
you to change a string, and `oats version --json` keeps
`"name":"@awebai/oats"` under either npm name, with the real name in its new
`package` field.

**Keep `@awebai/oats` installed.** This release installs over it, under the
same name.

- `npm rm -g @awebai/oats` leaves running sessions without their kernel until
  they restart. A start rewrites each home's `.oats/bin/oats` and hooks.
- The host's schedule unit stays on the old path until `oats schedule host
  install` runs.
- Installing the other name with `--force` and then removing the old one also
  deletes the `oats` command.

## Coming from an older version

Read the `## Upgrade` section of every release after yours, up to the
latest: each release's own steps are there, and only there. This list is a
guide to them, not a replacement: it names, newest first, the releases whose
Upgrade section asks a host for more than [the steps](#the-steps), the order
of the Desktop and the CLI, and an optional package pin. A change a script
must follow is in its release's Upgrade section whether or not it is listed
here.

- **[0.69.12](release-notes/v0.69.12.md#upgrade):** the catalog pins
  oats.okf 5.8.0, oats.aweb 1.37.0 and oats.framework 1.22.1. Where
  `oats.aweb-tasks` is composed, readiness warns until the host wake daemon
  runs aw 1.36.54 (install it by version while npm's `latest` is 1.36.53),
  aweb-channel 1.8.2 or @awebai/pi 0.4.1; on macOS, reload running custody
  jobs by hand after the aw upgrade.
- **[0.69.11](release-notes/v0.69.11.md#upgrade):** the catalog pins
  oats.framework 1.21.0 and oats.aweb 1.35.0. Upgrade every deployment of a
  workspace before its shared `oats-workspace.yaml` sets `tasks:` (an older
  kernel refuses the file). A pi home may warn `pi-extension-skills-loaded`
  until its pi extension entry carries `"skills": []`.
- **[0.69.10](release-notes/v0.69.10.md#upgrade):** the catalog pins
  oats.framework 1.20.0 and oats.aweb 1.34.0. With oats.aweb 1.34.0, a
  deployment that uses aweb tasks composes `oats.aweb-tasks`. Upgrade every
  deployment of a workspace before its shared `oats-workspace.yaml` uses an
  `ssh://user@host/...` reference.
- **[0.69.9](release-notes/v0.69.9.md#upgrade):** the catalog pins
  oats.framework 1.19.0, oats.aweb 1.33.1 and oats.engineering 1.18.0. With
  oats.engineering 1.18.0, a stop doesn't hold while a checkpoint is pending:
  `oats schedule disable <id>` keeps it stopped. Claude homes read their
  joined teams at task boundaries, so an idle one doesn't wake for that mail.
- **[0.69.8](release-notes/v0.69.8.md#upgrade):** the catalog pins
  oats.framework 1.18.0.
- **[0.69.7](release-notes/v0.69.7.md#upgrade):** the catalog pins
  oats.framework 1.17.0. This release is the bridge of
  [the move to the oats-project organisation](#the-move-to-the-oats-project-organisation):
  keep `@awebai/oats` installed. Until a deployment runs this kernel, run no
  wake jobs on a home that can open an approval or question dialog.
- **[0.69.6](release-notes/v0.69.6.md#upgrade):** the catalog pins oats.okf
  5.7.0 and oats.framework 1.16.4. On the review host of a workspace's
  harvest-review trigger, re-review each knowledge PR parked on
  `okf-needs-human` as its notes say.
- **[0.69.5](release-notes/v0.69.5.md#upgrade):** the catalog pins oats.okf
  5.6.0 and oats.cloning 1.1.0, which require OATS >=0.69.2. Every host that
  shares a workspace runs OATS 0.69.2 or later before any of them syncs to
  them; an older kernel drops their souls and refuses new spawns that compose
  them. It also pins oats.aweb 1.32.1 and oats.framework 1.16.3.
- **[0.69.2](release-notes/v0.69.2.md#upgrade):** the catalog pins
  oats.framework 1.16.1 and oats.okf 5.5.0. Sync each deployment before its
  instances on oats.okf 5.5.0 write proposals: an older harvester refuses
  them. A soul's `background: true` waits until every deployment runs 0.69.2.
- **[0.69.1](release-notes/v0.69.1.md#upgrade):** 0.69.0 was tagged but never
  published; 0.69.1 carries all of it, so follow
  [0.69.0's Upgrade section](release-notes/v0.69.0.md#upgrade): the Desktop
  first, then the CLI: a 0.68 Desktop refuses a 0.69 CLI. Every host that shares a workspace
  runs OATS 0.68.0 or later before any of them syncs to oats.aweb 1.32.0.
- **[0.68.0](release-notes/v0.68.0.md#upgrade):** the Desktop first, then the
  CLI: a 0.67 Desktop refuses a 0.68 CLI. The catalog pins new package versions; after `oats sync`, a stopped
  home can move to them with `oats instance upgrade` instead of a respawn
  ([Moving existing homes](#moving-existing-homes-to-locked-package-versions)).
- **[0.67.0](release-notes/v0.67.0.md#upgrade), first published as
  0.67.1:** the leader is Ctrl+X in OATS Desktop and in `oats tui`, on every
  platform; a leader you rebound is kept. A `tui.json` that gives `ctrl+x` to an action and names no leader
  stops `oats tui` from starting: give that action another key, or name a
  leader ([Change the keys](tui.md#change-the-keys-tuijson)). On Linux and
  Windows the shared shortcuts are Ctrl+Alt; a terminal that passes
  Ctrl+Shift apart from Ctrl takes the Ctrl+Shift option.
- **[0.66.0](release-notes/v0.66.0.md#upgrade):** `oats tui` moves its key
  file to `~/.oats/config/tui.json`; `oats server connect` needs `--dir`.
- **[0.62.0](release-notes/v0.62.0.md#upgrade):** after the CLI, run
  `oats setup` once per user on each host, from that user's shell: the
  capture service ([Capture service release order](#capture-service-release-order)).
- **[0.61.0](release-notes/v0.61.0.md#upgrade):** restart a pi instance stuck
  on its opening task once the bridge has moved; `oats onboard`'s
  `next.spawn` names the soul that holds oats.setup.
- **[0.60.0](release-notes/v0.60.0.md#upgrade):** `running` in
  `oats status --json` means the harness is running.
- **[0.59.0](release-notes/v0.59.0.md#upgrade):** with oats.aweb 1.28.0, a
  host that needs the wake broker installs it once (`oats aweb wake install`,
  from its own login session); `oats tui`'s back key is pressed twice.
- **[0.58.0](release-notes/v0.58.0.md#upgrade):** on a Mac, upgrade the CLI
  before the next reboot.
- **[0.57.1](release-notes/v0.57.1.md#upgrade):** upgrade the hosts a Desktop
  reaches over `--server` too; `oats tui`'s panel needs tmux 3.2 or later.
- **[0.57.0](release-notes/v0.57.0.md#upgrade):** a retire plan taken before
  the upgrade is refused once (`E_PLAN_STALE`); `oats worktree remove` may
  refuse with `E_CHILDREN_RUNNING`; with oats.okf 5.2.0, new spawns carry the
  harvest duty unless the soul opts out.
- **[0.56.0](release-notes/v0.56.0.md#upgrade):** new refusal codes for
  scripts; `open-workspace` in `tui.json` is `open`; a launch gets only its
  capabilities' declared environment.
- **[0.55.1](release-notes/v0.55.1.md#upgrade):** pin oats.aweb 1.27.3 and run
  `oats sync`: on 1.27.2, readiness reports every home the host wake broker
  serves as `unavailable`.
- **[0.55.0](release-notes/v0.55.0.md#upgrade):** the first capture after the
  upgrade takes longer.
- **[0.53.0](release-notes/v0.53.0.md#upgrade):** from 0.51 or earlier, do
  0.52.0's steps first (aw 1.36.33 or later, before `oats sync`); once the
  CLI is 0.53.0, run `oats update` in each deployment that launches pi (an
  older CLI's `oats update` moves the default pi folder only); run
  `oats setup` again where it was run; restart Claude Code instances on a
  Homebrew `node`; rerun `oats aweb resident create` for an existing
  resident custody unit; `oats doctor` names unmatched `souls.launch` keys.

**Coming from before 0.53.0:** read the whole notes of every release after
yours: up to 0.39.0 the section may be called `## Upgrading` or
`## Upgrading from <version>`, and some releases give their order under
another heading (0.49.0's oats.okf 5.0 cutover, for one).

### Capture service release order

The bounded periodic capture service (service A) is **not shipped in
[0.56.0](release-notes/v0.56.0.md) through [0.61.0](release-notes/v0.61.0.md)**
([0.57.0](release-notes/v0.57.0.md), [0.57.1](release-notes/v0.57.1.md),
[0.58.0](release-notes/v0.58.0.md), [0.59.0](release-notes/v0.59.0.md) and
[0.60.0](release-notes/v0.60.0.md) included). Those releases retain the
existing capture watcher, and upgrading to any of them does not install the
periodic service. The capture algorithms and recovery commands already
released do not prove that migration happened.

For those released versions, follow their own Upgrade sections and
[the steps](#the-steps), the target Desktop before the CLI.

Service A ships in [0.62.0](release-notes/v0.62.0.md) and every later
release. Read 0.62.0's Upgrade section and keep this order: install the
Desktop of the release you upgrade to first (its notes give the CLIs
it accepts), then that release's CLI and matching pi bridge. Only **after
installing that CLI**, run its setup conversion once per user on each host,
from that user's shell, then its health and doctor checks. That conversion is where an owned legacy
watcher is replaced by the periodic service; foreign or disabled definitions
require an explicit operator choice. The conversion accepts `setup --root <dir>`
and `--replace-service`; refusal prints a quoted command preserving owner/root.
Choose `--no-service` to skip service files and manager operations entirely.
`--dry-run` writes nothing and calls no manager, so disabled/registered state
remains unexamined. Replaced definitions are backed up nonoverwriting under
the selected record root; retain the reported backup and inspect any partial
apply error before retrying. Replacement never waives unknown state or changed
identities. A CLI install alone is not conversion.
Use that release's capture health and doctor checks after conversion. Do not
run the service diagnostics or conversion flags as prerequisites on 0.61.0 or
older binaries, which do not have them, or assume that an older health command
proves periodic activation. The [capture reference](../packages/record/docs/capture-service.md)
distinguishes the implemented foundation from an installed service.

The first capture after that upgrade rebuilds the record root's derived
capture state and index from the existing journals: it validates each journal,
proves each session's captured prefix against a fresh staged copy of its
source, and indexes every record. This cost is paid once, and it grows linearly with the
number of streams and their bytes. On the hosted Linux runner (4 CPUs) it took
about 20 seconds per 1,000 streams of typical small sessions, and about 4
minutes per GB of journals overall: a record of about 1,300 streams and 8 GB of
journals needs roughly half an hour of capture work in about seven bounded
passes, which under the service's 15-minute interval is one to two hours of
elapsed time. A later pass over unchanged sessions does no content work and
costs about 2 ms per stream on the same runner (about 3 s at 1,300 streams),
growing linearly with the number of streams. Each pass stops at its deadline. A first upgrade that is interrupted or reaches its deadline resumes
from its durable checkpoints on the next pass (journal validation, index
cursors, the prefix proof and the staged copies of sources over 8 MiB) rather
than starting over; a smaller session's staged copy is made again. Reducing the
repeated source reads of small sessions is tracked in
[#1337](https://github.com/awebai/oats/issues/1337).

**Going back to 0.61.0.** Until the steps below are done, two things fail at
every trigger:

- each `Stop` and `SessionEnd` hook this release's setup wrote exits 1,
  because its command names `bin/capture-hook.mjs`, a file 0.61.0 does not
  have; Claude does not block on it;
- the periodic service's start fails every 15 minutes: on Linux
  `turn-record-capture.timer` starts a unit whose runner 0.61.0 does not have,
  and on macOS the `ai.aweb.turn-record-capture` job fails the same way.

To go back:

1. Install 0.61.0: `npm install -g @awebai/oats@0.61.0`.
2. From the same user's shell, run 0.61.0's setup with the same owner:
   `oats setup --owner <owner>`. It installs its capture watcher (on Linux as
   `turn-record-capture.service`, on macOS under the same
   `ai.aweb.turn-record-capture` label) and adds its own `Stop` and
   `SessionEnd` hooks. 0.61.0's setup takes no `--root` (it refuses one):
   everything it starts records into `$TURN_RECORD_ROOT` as that process sees
   it, else `~/.turn-record`. Its first pass runs with setup's environment, so
   `TURN_RECORD_ROOT=<root> oats setup --owner <owner>` points that pass at
   another root; its hooks see Claude's environment; its watcher's service
   sets none, so the watcher gets only the user manager's environment and
   records into `~/.turn-record` unless the user manager itself sets
   `TURN_RECORD_ROOT`. With any other root, the watcher and the record you
   were using part ways.
3. In each `~/.claude*/settings.json`, delete the hook entries under `Stop` and
   `SessionEnd` whose command names `capture-hook.mjs`: 0.61.0's setup does not
   recognize them and leaves them in place.
4. On Linux, remove the timer:
   `systemctl --user disable --now turn-record-capture.timer`, then delete
   `~/.config/systemd/user/turn-record-capture.timer` and run
   `systemctl --user daemon-reload`.

After going back to 0.61.0, its `oats capture --health` reports the capture
status file this release wrote as invalid, and a capture by 0.61.0 clears the
run history in that file. A later capture with this release writes a fresh
status. 0.61.0 ignores the captured frontier this release keeps in an AW log's
cursor during a rescan and drops it when it rewrites that cursor; it reads that
log without a record limit, so nothing is lost.

## Which pi folders

pi keeps its packages in one folder: `~/.pi/agent`, or the folder
`PI_CODING_AGENT_DIR` names. A deployment can launch pi with several folders,
so `oats update` and `oats doctor` look at each of these:

- **the default**, `~/.pi/agent`;
- **this shell's**, when `PI_CODING_AGENT_DIR` is set where the command runs;
- **each launch configuration's**: the `PI_CODING_AGENT_DIR` in the `env` of
  every `launch-configs` entry of the deployment's `oats-local.yaml` whose
  harness is `pi` ([Configuration](configuration.md#launch-configurations)).
  The value is a path, or a `{fromEnv: NAME}` reference read from the
  environment the command runs in. A leading `~` is your home.

Two names for one folder (two configurations, a configuration that names the
default, a symbolic link) are one folder, listed once with every reason it is
looked at.

The bridge of a folder is read from
`<folder>/npm/node_modules/@awebai/oats-pi/package.json`, where pi installs
it.

**The deployment** is the one at or above the directory the command runs in,
or the one `--dir` names. With no deployment there, `oats update` still moves
the default folder and this shell's, and says, in the plan and again as its
last line, that no launch configuration was looked at. It says the same about
a deployment whose `oats-local.yaml` it cannot load; `oats doctor` reports
what is wrong with that file. An explicit `--dir` with no deployment at or
above it is refused.

**Folders that are not looked at.** Only the deployment's current
`launch-configs` are read. An instance home records the launch it was created
with, and keeps it when the configuration is later changed or removed; a
folder named only by such a record is not in the list. Move its bridge with
the command under [By hand](#by-hand).

## What `oats update` does in each folder

The plan lists every folder with the bridge found in it and one of these:

| The plan says | When | What happens |
|---|---|---|
| `move to <version>` | the bridge is at an older version | `pi install` runs there |
| `left alone, already at <version>` | the bridge is at that version | nothing |
| `left alone, ahead of <version>` | the bridge is at a newer version | nothing: a bridge is never moved back |
| `no bridge` | the folder does not exist, or holds no bridge | nothing |
| `not touched`, with a reason | see below | nothing; the plan prints the command to run there |

`oats update` moves a bridge. It never creates a folder and never installs a
first bridge: a spawn's own package check says when a capability needs one
that is missing.

A folder is **not touched** when:

- **it does not resolve**: a `{fromEnv: NAME}` whose variable is not set where
  the command runs, or a path that is not absolute. Run `oats update` again
  where the variable is set, or the printed command.
- **its bridge cannot be read** (a `package.json` that does not parse).
- **only launch configurations with their own `executable` name it.** A
  wrapper is your program: `oats update` never runs one. The plan prints the
  install command with that executable; when the configurations name several
  executables, one command for each, with the configurations it is for. A
  folder that the default, this shell or a configuration without an
  `executable` also names is moved with the plain `pi`.

For a folder it moves, `oats update` runs the `pi` found on `PATH`, with
`PI_CODING_AGENT_DIR` set to that folder:

```sh
PI_CODING_AGENT_DIR=<folder> npm_config_prefer_online=true pi install npm:@awebai/oats-pi@<version>
```

For the default folder the variable is left out, unless this shell sets one.

## Nothing is removed before its replacement is known to install

The move is one `pi install` over the installed bridge. pi replaces the
settings entry and the files of a package it already holds, and an install
that fails leaves the old ones in place. There is no `pi uninstall`.

Before any step runs, the CLI's own install included, `oats update` asks the
registry for the bridge's exact version, with npm told to revalidate its
cache (`npm view @awebai/oats-pi@<version> version --prefer-online`). A new
version is listed a few minutes after it is published, and the kernel's
listing says nothing about the bridge's. If the version does not resolve,
the update stops with nothing changed and every bridge in place: run it again
in a few minutes. The same setting goes to pi's own npm for the install
(`npm_config_prefer_online=true`). `--check` does not make this lookup: it
shows what would run, and the run looks again.

When the installed CLI is ahead of the registry, the version asked for is
the installed one, and it may not be published at all. The plan does not
know: it makes no lookup. So when it lists a move to that version, it says
under the folders what the move depends on:

```text
  A bridge moves to 0.53.0 only if @awebai/oats-pi@0.53.0 is published: the installed kernel is ahead of the registry's 0.52.0, and a run checks that before any step.
```

When the run's lookup then does not find the version, the message says that
the installed kernel is ahead of the registry, instead of telling you to wait
a few minutes.

**What npm answers is checked before it is used.** Both lookups must answer
one version and nothing else: three numbers and an optional prerelease, on
one line. Any other answer (nothing, several lines, a list, text around the
version) stops the update before any step, with nothing changed. The message
names the lookup and shows the answer cut to 80 characters, with its control
characters shown as escapes or replaced. Run `oats update` again.

npm's own error output of a lookup is not passed to your terminal either.
When the first lookup fails, the message says how it ended (`exit 1`) and
then what npm said, cut to 300 characters and made safe the same way.

The update stops at the first step that fails. Its message names the folder
and the exact step to run again, says what that folder holds now (the old
bridge still, or no bridge), and lists the folders it did not reach. A step
that ends without an error but leaves another version in the folder is a
failure too. Run the printed step, then `oats update` again: folders already
at the version are left alone.

## What `oats doctor` reports

From the next release after 0.61.0 (service A), deployment doctor also delegates once to
the record package's offline health reader. Text and JSON carry its diagnosis
as existing warning rows. `capture-health-unavailable` means the bounded command
or reader failed, timed out, exceeded its output limit or returned an invalid
envelope; inspect `oats capture --health --json` with the same root environment.
Doctor retains its warning exit semantics. `TURN_RECORD_ROOT` selects the root,
otherwise the caller's `~/.turn-record` applies; `--soul` remains composition-only.
The kernel adds no status/DB/freshness parser or manager probe. Remedies use
`oats`, preserving literal user paths and existing owner guidance. Neither no
warnings nor definition bytes prove enabled scheduling. See the
[owning boundary](../packages/record/docs/capture-service.md#kernel-doctor-delegation)
for reader/transport limits and remaining qualification. This does not change
the released 0.56–0.61 upgrade prerequisites above.

`oats doctor` prints one warning per folder whose bridge is not the kernel's
version, naming the folder and why it is looked at:

```text
WARNING: version skew — kernel 0.53.0, pi bridge 0.52.0 in /srv/pi-work (launch configuration work); run `oats update` (they publish in lockstep)
```

A bridge ahead of the kernel is a skew too. `oats update` moves no bridge
back, and `oats doctor` does not ask the registry, so the warning says what
ends the skew:

```text
WARNING: version skew — kernel 0.52.0, pi bridge 0.53.0 in /srv/pi-work (launch configuration work); the bridge is ahead of the kernel, and `oats update` never moves a bridge back. The skew ends when the kernel is at 0.53.0 (`oats update` moves it once npm lists that version), or when the kernel's bridge is installed there by hand (docs/upgrading.md, "By hand")
```

It also warns about a folder it could not look at (one that does not
resolve, or a bridge that cannot be read). A folder that does not exist or
holds no bridge is not a skew, and it says nothing about it. The warnings are
in the text output only; `oats doctor --json` does not carry them.

## After a change of Node version

Two paths are written into things that outlive a command: the kernel's, and
the `node` that runs it. A new Node version can leave either behind.

**The kernel's path.** The CLI is an npm global package: it is installed
under npm's global prefix (`npm prefix -g`).

- **The prefix is outside the Node install.** The kernel's path does not
  change with the Node version: the CLI needs no reinstall.
- **The prefix is the Node version's own directory**, the usual layout of a
  version manager (mise, nvm, asdf, fnm). Every Node version then has its own
  global packages: a new version has no `oats`, and removing the old version
  removes the kernel with it. Four things name that kernel by its path: each
  instance home's own `oats` (`<home>/.oats/bin/oats`), the Claude Code hooks
  of a Claude instance, the host timer's unit, and what `oats setup` installs
  (the turn record's capture hooks and its periodic capture service, which
  name the capture scripts inside the kernel). OATS cannot make a path
  inside a Node version outlast that version.

Both layouts can exist on one host: check the prefix in the shell that
installs the CLI.

**The `node`'s path**, whatever the prefix. The Claude Code hooks of a
Claude instance, the host timer's unit and what `oats setup` installs also
record the `node` that runs them, by one rule
([the node a hook writes down](capabilities.md#the-node-a-hook-writes-down)):

- **On Homebrew**, the `opt` link (`<prefix>/opt/node/bin/node`) when it is
  the `node` running the kernel. `brew upgrade node` repoints it, so the
  recorded path outlasts the upgrade: the hooks, the timer and the capture
  service need nothing done.
- **Otherwise**, a `node` on `PATH` that is the same file as the one running
  the kernel. With mise that is the version's own install, which does not
  outlast the version (other version managers were not measured).
- **When there is neither**, the path of the `node` as it is. A spawn, a
  start, `oats schedule host install` and `oats setup` then warn that it is
  not stable.

**What `oats setup` records is in your own files, not in an instance home:**
the capture hooks (`Stop` and `SessionEnd`) in every `~/.claude*/settings.json`
of the user who ran it, and the periodic capture service's definitions. On
macOS that is `~/Library/LaunchAgents/ai.aweb.turn-record-capture.plist`, a
launchd job with `StartInterval` 900; on Linux, a finite
`~/.config/systemd/user/turn-record-capture.service` started by
`turn-record-capture.timer` every 15 minutes. Each start runs one bounded
capture pass and exits. No spawn, start or restart writes them: only
`oats setup` run again does. It replaces its own hooks and definitions, and
converts a capture watcher an earlier setup installed; it does not add a
second one. A definition it does not recognize as its own, or one found
disabled or masked, is refused with a printed choice: `--replace-service` to
replace it, or `--no-service` to keep it and skip service files and manager
calls. One exception on macOS: the capture label registered from another plist
is refused even with `--replace-service`; remove that registration yourself,
or keep it with `--no-service`. A service manager failure does not skip
capture: setup still writes the hooks and runs the first pass, exits 1 and
prints a setup summary of what changed; rerun the printed command, which
finishes setup's own activation without a flag. Until then `oats doctor` warns
`capture-service-pending`. `--dry-run` prints what setup would do and changes
nothing ([Capture service release order](#capture-service-release-order)).

Once the recorded `node` no longer exists (an old version removed under a
version manager, for example), the hooks fail without a message, so the
instance stops reporting that it waits on you, and
`oats schedule host status` reports `node-missing`. The capture hooks then
fail at every stop of every Claude Code session of that user, and every
15-minute start of the capture service fails.

**A home spawned with an oats.core that does not read `OATS_NODE_BIN`** does
not follow the rule. Its hooks record the path of the `node` its hook ran
under, which on Homebrew is the versioned keg
(`…/Cellar/node/<version>/bin/node`), and a start writes that again, because
a start runs the copy of oats.core in the home. `brew upgrade node` removes
the keg at once, so such a home needs the restart of step 2 after every Node
upgrade, until it is respawned.

So after moving to another Node version, and before removing the old one,
wherever a recorded path does not outlast it:

1. Where the prefix is the version's own directory, install the CLI in the
   new version: `npm install -g @awebai/oats`.
2. Restart the instances, from a shell on the new version
   (`oats session restart --home <home>`). A start writes the home's `oats`
   and its Claude Code hooks again
   ([Configuration](configuration.md#launch-configurations)).
3. On a host that runs schedules, run `oats schedule host install` again,
   from your own shell, not from an instance home. Without it,
   `oats schedule host status` reports `oats-bin-missing` or `node-missing`
   once the old version is removed
   ([Schedules](schedules.md#the-host-timers-unit)).
4. On a host where `oats setup` was run, run `oats setup` again, as the same
   user and from your own shell. `oats setup --dry-run` prints the `node` it
   would record and changes nothing.

Until the old version is removed, the instances and the timer keep running
what it holds.

## By hand

In any pi folder, with the `pi` that is launched with it:

```sh
PI_CODING_AGENT_DIR=<folder> pi install npm:@awebai/oats-pi@<the CLI's version>
```

`oats version` prints the CLI's version. For the default folder, leave the
assignment out only when your shell does not set `PI_CODING_AGENT_DIR`;
when it does, name the folder: `PI_CODING_AGENT_DIR="$HOME/.pi/agent"`.
