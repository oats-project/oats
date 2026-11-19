---
name: oats-automations
description: >-
  Use when setting up or changing what an OATS workspace runs without a
  person: triggers (spawn an instance when a GitHub pull request event
  happens, or an event a capability's trigger source lists) and schedules (spawn, command or wake on a cron), local to one
  machine or declared in the workspace (oats-triggers/, oats-schedules/,
  runsOn, owner); installing the host timer; testing a trigger; or explaining
  why an automation did not run here. Part of the setup and config of an OATS
  workspace (oats.setup); day-to-day operation inside an instance is oats.core.
---

# Automations: triggers and schedules

The contract is `docs/schedules.md` in the installed kernel ("Kinds",
"Triggers", "Workspace triggers and schedules", "Commands"). Read it before writing a definition. Two kinds:

- a **schedule** spawns an instance, runs an `oats` command or wakes an
  existing instance on a five-field cron with an explicit IANA `tz`;
- a **trigger** spawns a NEW instance when an event matches: "when EVENT,
  spawn SOUL with TASK, in TEAMS". The event comes from the built-in
  `github.pull_request` source or from a **trigger source** a capability
  declares (`on.source: "<capability>:<source>"`, OATS 0.50.0).

## One host timer, no daemon

A machine runs its automations through **one host timer** (a user
LaunchAgent on macOS, a `systemd --user` timer on Linux) that runs
`oats schedule tick --host` every minute. The tick evaluates what is due,
launches it through the same spawn path a person uses, records what it saw
and exits. Missed minutes are skipped, never replayed.

```bash
oats schedule host status      # is the timer installed and active on this machine? what is wrong with its unit?
oats schedule tick --dry-run   # what would run this minute, launching nothing
```

**Installing the timer is the operator's step, in their own shell, never yours:**
`install` renders the unit from the environment of the shell it runs in, and an
agent's shell can carry a session's own `PATH` and node (`docs/schedules.md`,
"The host timer's unit"). Hand the operator the exact command, with the flags
they want (the cap flags below included), to run in their own terminal, from
the deployment directory and outside every instance home:

```bash
oats schedule host install
oats schedule host install --max-concurrent 3 --triggers-max-concurrent 2
oats schedule host install --max-concurrent default --triggers-max-concurrent none
```

Do not run it yourself, with or without flags, and do not offer its `--print`
from your shell as a preview: that renders your environment, not the
operator's. After the operator has run it, check the result yourself with
`oats schedule host status`: it reports `unit-outdated` and the unit's other
problems, each with its fix. With no operator at the machine, the timer stays
as it is until they run the command: say what is waiting, and do not run it in
their place.

The default cap is five running scheduled jobs. The two install flags set
independent positive-integer caps; `default` restores the schedule default and
`none` removes the trigger cap. Omitted flags keep existing choices. Use these
CLI flags, never hand-edit the registry. Reads take no registry lock and write
nothing; they interpret the old implicit cap of one as five. The next registry
mutation persists that migration and emits a stderr notice; a pre-migration
hand-set one is indistinguishable, so explicitly set `--max-concurrent 1` if the
operator needs one. Older binaries can reintroduce one while retaining the new
marker: stop mixed-version writes and set the desired cap with the CLI. Invalid
stored caps are refused, not replaced with five; an explicit `--max-concurrent
N|default` repairs an invalid schedule cap. `host status` reports both effective
caps.

**Credentials reach the tick through the timer, not your shell.** The timer's
environment sets only `PATH` and `OATS_HOME_DIR`. `gh` logged in through the
keyring or its config file works; a `GH_TOKEN`/`GITHUB_TOKEN` exported in a
shell does not. `oats trigger test` reports where `gh`'s credential comes from
and warns when the timer cannot reach it.

## Local automations (this machine only)

Stored in the deployment's `oats-schedules.json`, run by this host with its
own credentials, visible to no other machine. Use them for personal or
experimental jobs. Schedule IDs allow 1–100 lowercase letters, digits and
dashes; trigger IDs allow 1–40. Use a short explicit `purpose` for a spawn
schedule with a long ID, so its derived instance name fits the 64-character
limit. Every schedule and trigger may carry an informational `description`:
1–200 characters on one line without control characters (OATS 0.43; before
it, local schedules only). It appears in list/show and the Desktop; it never
changes what runs. Set it in the spec or with `--description=<text>`; change
only it with `update <id> --description=<text>` (`--description=` clears it).

```bash
oats schedule add <id> --file spec.json      # spawn | command | wake (the shapes: docs/schedules.md "Kinds")
oats schedule list
oats schedule enable <id>
oats schedule disable <id>
oats schedule run <id>                       # now, under the same lock
oats trigger add --file trigger.json         # or from a package template:
oats trigger add --from <package>:<template> --set repo=github.com/<org>/<repo> [--description=<text>]
oats schedule update <id> --description=<text>   # the description only, even while it runs
oats trigger update <id> --description=<text>    # the description only (local triggers)
oats trigger list
oats trigger test <id>                       # dry run: gh auth, repo permissions, soul resolves, teams declared, what would fire
oats trigger test <id> --run-source          # a capability source's trigger (OATS 0.50.0): the same, RUNNING its source command on this host
oats trigger poll <id> --run-source          # a capability source's trigger (OATS 0.50.0): run its source once, record nothing
oats trigger status <id>                     # last poll, pending events, fired keys, live instances, last error
```

`oats schedule list` counts triggers but does not list them; manage triggers
only with `oats trigger`. Removing a trigger leaves the instances it spawned
running.

### A trigger, field by field

```json
{ "id": "okf-proposal-review", "enabled": true, "kind": "trigger",
  "on": { "source": "github.pull_request", "repo": "github.com/acme/knowledge",
          "events": ["opened", "reopened", "ready_for_review"],
          "labels": ["okf-proposal"], "base": "main", "poll": "2m" },
  "spawn": { "soul": "oats.okf/knowledge-maintainer", "purpose": "review-pr-{number}",
             "task": "Review knowledge-base PR {repo}#{number}.",
             "harness": "claude", "model": "opus" },
  "concurrency": { "max": 2, "perKey": 1 } }
```

- **Source** `github.pull_request`: the tick polls open PRs with the host's
  `gh`. `labels` (all must be present) and `base` filter them. Events:
  `opened`, `reopened`, `ready_for_review`, `labeled`, `synchronize`. (A
  capability's source: see below.)
- **Templates substitute only** `{repo} {number} {url} {event} {headSha}
  {trigger} {subject} {key}` (`{subject}` from OATS 0.49.0). A PR's title and body are untrusted and never
  reach the task; the instance reads them from GitHub.
- **Delivery is at least once.** A fired key is recorded only after a
  successful spawn, so a crash can spawn an event twice; `perKey: 1` holds the
  second until the first instance retires. The soul must tolerate a second
  run on the same event. From OATS 0.49.0, `perKey` counts by the event's `subject` (a PR's
  number), so an `opened` and a later `synchronize` of one PR share a slot.
- **Instance names** are `<stem>-<purpose>` (stem: the soul's agent name as
  a slug). From OATS 0.49.0, a name over 61 characters gets a cut purpose
  ending in a 6-character hash of the event key. When the stem is over 54
  characters, a name that needs cutting cannot be made, and the event stays
  pending (`E_INSTANCE_NAME_INVALID` in `oats trigger status`). `oats trigger test <id> --json` shows each
  would-fire event's `instance` and `nameCut`.
- **`teams`** (optional) becomes the messaging capability's `join=` for the
  spawn (see oats-teams); every label must be declared, and the soul needs a
  messaging capability (`E_TRIGGER_TEAMS`). Without it the instance lives in
  its default team only.
- The spawned instance gets the event as `OATS_TRIGGER_EVENT_FILE`, and its
  task ends with a "Triggered run" block naming it.

### A trigger on a capability's source

A capability may declare trigger sources in its manifest (`triggerSources`;
`oats capabilities show <capability>` lists them and any problem). The
contract is `docs/schedules.md`, "Capability sources".

```json
{ "id": "harvest-review", "kind": "trigger",
  "on": { "source": "acme.graph:harvest-branches", "params": { "prefix": "harvest/" },
          "events": ["opened", "updated"], "poll": "2m" },
  "spawn": { "soul": "graph-reviewer", "task": "Review branch {subject} of graph {fields.graph}." } }
```

- `on` takes `params` (strings, the source's parameters) instead of `repo`,
  `labels` and `base`; `events` are the source's. Templates may name
  `{trigger} {source} {subject} {event} {key} {url} {fields.<name>}`; the
  default purpose is `{trigger}-{subject}`.
- `trigger add` checks the definition against the soul: it must compose the
  capability, and the source, params, events and fields must be the ones it
  declares (`E_TRIGGER_SOURCE`, `E_TRIGGER_INVALID`). A later poll that finds
  them no longer valid shows the trigger as `invalid` in `list` and `status`.
- **`trigger poll <id> --run-source` and `trigger test <id> --run-source`
  execute the capability's source command**, by hand, even on a host that
  does not trust the trigger or is not its `runsOn`: use them to try a
  source before trusting it. They record and spawn nothing. Without
  `--run-source` both are refused (`E_TRIGGER_SOURCE_RUN`; nothing ran,
  nothing was written) and the message gives the command to run again. The
  flag is caller intent, never trust consent: it says you mean to run
  provider code here, now, and the tick alone is gated by trust and
  placement, exactly as before. Pass it only when the task or your human
  asked for the source to run.
- A pending event the source stops listing is dropped; a failed poll drops
  nothing (`status` shows `lastPoll.cause` and what the source said).
- The source runs under the host timer with only `PATH` and `OATS_HOME_DIR`:
  its login must live in its own store under `HOME`, not in an exported
  variable (`trigger test --run-source` warns every time).

## Workspace automations

Anything a team relies on belongs in Git, reviewed like a soul, and says
**which machine runs it** and **which GitHub account it acts as**. The
contract is `docs/schedules.md`, "Workspace triggers and schedules".

| | trigger | schedule |
|---|---|---|
| folder at the member's root | `oats-triggers/` | `oats-schedules/` |
| or anywhere in the member | `*.oats-trigger.yaml` | `*.oats-schedule.yaml` |
| `kind:` | `oats-trigger` | `oats-schedule` |
| opt-out on one host | `triggers.disabled` | `schedules.disabled` |

```yaml
# <member repo>/oats-triggers/<id>.yaml
kind: oats-trigger
schemaVersion: 1
description: Review every knowledge proposal PR on the knowledge base
from: oats.okf:proposal-review         # a package template, then its parameters; or on/spawn/concurrency in full
set: { repo: github.com/<org>/<repo> }
runsOn: <host name>                    # a machine's oats-local.yaml host.name
owner: github.com/<account>            # the account it acts as
```

A workspace schedule is the same shape (`kind: oats-schedule`, `run: spawn`
or `run: command`, `cron`, `tz`, `agent`, `task`, plus `runsOn` and `owner`).
`wake` stays local: it targets one machine's instance home.

- **Discovery.** Read from confirmed members only, named `<member>/<id>` (the
  id is `id:`, else the filename stem); local ones are `local/<id>`. Never
  read from `oats-package/`, `.git/` or `node_modules/`. A wrong or missing
  `kind` is `E_AUTOMATION_SCHEMA`; a repeated id for one kind in one member is
  `E_AUTOMATION_DUPLICATE`. A trigger and a schedule may share an id.
- **Who runs it.** A host runs one only when `runsOn` is its `host.name`
  **and** its `gh` is logged in as `owner`. Otherwise it is listed with why
  not: `assigned-elsewhere`, `owner-mismatch` or `host-unnamed`. So "exactly
  one machine" is a declared fact, and consent is explicit: a machine acts for
  an account only when its operator named it and logged in as that account.
- **Opting a host out** without a commit: `oats trigger disable <member>/<id>`
  writes `triggers.disabled`, and `oats schedule disable <member>/<id>` writes
  `schedules.disabled`, in that host's `oats-local.yaml`; `enable` removes
  the entry. Qualified schedule names accept up to 100 characters in opt-outs
  and named `automations.trust` entries; trigger definitions and opt-outs stay
  limited to 40. A workspace definition is never edited or removed from a host
  (`E_AUTOMATION_WORKSPACE`): change the file in Git.
- **Refresh.** `oats sync` takes a snapshot of the members' automations; the
  host tick refreshes it when it is more than ten minutes old
  (`oats automations refresh` does it now). A merged change reaches the named
  host within about ten minutes. Run state (fired keys, the last poll) stays
  per host.
- **Writing one.** In a checkout of the member, this writes
  `oats-triggers/<id>.yaml` for you to commit; anywhere else it prints the
  file. Either way it is validated first.

  ```bash
  oats trigger add --from <package>:<template> --set repo=github.com/<org>/<repo> --workspace <member> --runs-on <host name> --owner github.com/<account>
  oats automations refresh          # once it is on the default branch, instead of waiting for the tick
  oats trigger test <member>/<id>   # on the named host: placement, gh account, repo permissions, soul, teams
  ```

  Commit it to that member as `/oats-workspace-config`, "Change a shared file" says.

## Unresolved schedule attempts

`oats doctor` reports `schedule-unresolved` warnings with the job ID, attempt
age, original error and whether the job holds a host slot. For a supported
local attempt, follow its `oats schedule reconcile <id>` remedy; use `--clear`
only after checking unproven effects by hand. Workspace guidance is offline:
known placement exclusions prevent reconciliation, and static eligibility is
not verified current authorization. Preserve retained state and inspect effects
with the deployment owner; clearing workspace attempts outside current placement
remains unsupported. Do not re-enable/retrust a job or delete locks to recover it.
An unknown last observation without a persisted attempt may be re-observed by an
eligible tick; it is not the same rerun-blocking condition and clearance is not
guaranteed. Doctor also checks other deployments registered with this host.

An unknown command or operation frees its host slot only after the kernel
observes its process exit. Scheduler command/operation and workspace-spawn
children receive SIGTERM at five minutes and SIGKILL after a two-second
cleanup grace if needed. Catchable SIGINT/SIGTERM/SIGHUP to the supervisor uses
the same cleanup; interruption stays unconfirmed even with a printed envelope.
SIGKILL/OOM or an unrecoverable supervisor death cannot guarantee child cleanup:
without its receipt, the unknown attempt retains its slot. Descendants that
start their own sessions are outside the owned group. Its own job stays blocked
until reconcile. Spawn,
wake and legacy attempts without observed exits retain their slot rules.

### Structural uncertainty during provider migration

A provider that cannot confirm dispatched effects or compensation sets
`error.details.unconfirmed: true` (a boolean). The operation wrapper promotes
that marker without dropping its nested receipt. Kernel incomplete-spawn and
rollback failures carry it too; completed compensation remains unmarked.
Existing text-based checks still protect older providers and copied homes.
Do not assume those copies were upgraded or retry a marked attempt without
reconciliation; the marker does not change host-slot release rules.

## Gotchas

- `oats trigger test` proves only the host it runs on. Run it where the
  automation runs, as the account it acts as.
- Two machines running one local trigger on the same repo each spawn an
  instance per event. For anything shared, use a workspace automation with
  `runsOn`.
- A trigger's `owner` that cannot merge (or approve) on the repo will spawn
  reviewers that cannot finish. GitHub forbids approving your own PR, so a
  reviewer bot needs its own account.
