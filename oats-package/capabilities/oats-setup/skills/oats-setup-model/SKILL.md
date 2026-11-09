---
name: oats-setup-model
description: >-
  Use first when someone wants to understand an OATS setup: what the
  workspace, members, packages, souls, capabilities, teams, instances and
  automations are, how they relate and why; "where does X come from", "why is
  X here", "why can't I see / spawn / join Y", "who is this agent acting as",
  "what runs on this machine", "why didn't my agent wake". Explains the model and names the command that
  answers each question. To change something, continue with
  `/oats-workspace-config`, `/oats-host-delivery`, `/oats-teams`,
  `/oats-package-pins` or `/oats-automations`.
  Part of the setup and config of an OATS workspace (oats.setup); day-to-day
  operation inside an instance is oats.core.
---

# The OATS setup model

Load this before explaining or changing a setup: every answer below is "read
it from the command, then explain it with the model". The contracts are the
installed kernel's docs (`"$(oats root)/docs/"`): `workspaces.md`,
`souls-and-instances.md`, `capabilities.md`, `packages.md`, `schedules.md`.
Cite them; do not restate them from memory. Start every explanation with the
reads:

```bash
oats workspace status     # members and why each is in or out, locked packages
oats souls                # every soul, its origin, its teams and default team
oats capabilities         # every capability, its origin
oats status               # the instances on this machine, and their drift
```

## The relations

Record capture setup is separate from workspace configuration and the host
automation timer. The package owns its service policy and migration readers:
from OATS 0.62.0, consult
`packages/record/docs/capture-service.md#setup-service-migration` in the
installed CLI. For an upgrade, read `docs/upgrading.md` (its
`#capture-service-release-order` included) and the release notes at the
latest release's tag, as `/oats-upgrade` does: the installed copy describes
the version being upgraded from.
`oats setup` can change capture hooks and user-manager definitions and run a
first pass; it is not a diagnostic to run implicitly.

**A person-run step**, from OATS 0.62.0 (periodic service A):
the record `oats setup` capture conversion records the caller's `node` and
writes the person's `~/.claude*/settings.json`, so it captures its own shell's
environment, like the host wake broker and the host timer, and an agent's shell
is not the person's login environment. It is the third of the person-run
installs the setup briefing lists; every other step the setup expert runs
itself. The setup expert prints the exact command and says why the person runs
it. A nonzero exit ends with a setup summary of what changed;
`capture-service-pending` in health or `oats doctor` means: rerun that command.
Preserve the selected `--owner`/`--root`; a foreign/disabled refusal offers
explicit `--replace-service` or `--no-service`. Unknown state never permits
replacement. If the summary says publication may have occurred but durability
was not established, inspect the named target/stage before rerunning; a sync or
close failure after rename does not mean the old file was restored. Preserve
that partial-apply evidence. `--dry-run` invokes no manager and cannot confirm
enablement.
An inactive finite worker between timer ticks is not evidence of an unhealthy
schedule; do not promise a permanent PID or infer completion from hook launch.
Releases 0.56–0.61 do not provide this conversion; follow their own instructions.

For service A, from OATS 0.62.0, the package's `turn-record capture --health [--json]` reads
installation evidence, receipt freshness/failure and current issues without
capture, repair or manager calls. Warning rows are valid diagnosis, not a command
failure. Unreadable/unknown candidates fail closed. An `ok` result or definition
file does not establish enabled scheduling; sleep/off-host execution can explain
old receipts. Use the owning reference's exact evidence rules. Deployment
`oats doctor` delegates once with a finite timeout/output bound and maps package
rows into warnings; `capture-health-unavailable` means the command/reader or
response failed, not healthy empty evidence. `--soul` stays composition-only.
Doctor uses the caller's HOME and `TURN_RECORD_ROOT` (default `~/.turn-record`),
not its deployment argument as a record root. Remedies say `oats`, while
standalone package remedies say `turn-record`; preserve quoted root and existing
owner selection. No manager registration/health or full-service acceptance
follows. Do not use these diagnostics as prerequisites on 0.61.0 or older binaries.

```
 GitHub account (a person, or a machine user)
   │  can read ──► member repos ──► its view of the workspace
   │  is `owner` of ──► workspace automations
   │
 WORKSPACE  (oats-workspace.yaml in the host repo, shared through Git)
   ├─ members ◄──two-way handshake──► oats-membership.yaml in each member   (= trust)
   │     each member contributes:  souls/  capabilities/  oats-triggers/ oats-schedules/
   ├─ packages (pinned) ──► capabilities + souls + trigger templates, at one locked commit
   ├─ shared teams (label ──► provider team id), the default team, which souls may join which teams
   ├─ defaults ──► capabilities every soul gets, one per core slot
   ├─ stores ──► knowledge bases, bound on each machine
   └─ external ──► souls borrowed from non-members, commit-pinned
                                │
 SOUL (a durable role) = workspace defaults → its own list
                                │ spawned by a person, an agent or an automation
 INSTANCE (one incarnation) = a home + ./work, on ONE machine, fixed to what it was given
                                │
 THIS MACHINE (the deployment directory): oats-local.yaml (+ local teams and a local default,
                                           only when the workspace allows them), oats-lock.json,
                                           agents/, clones, the host timer
```

## The pieces, and why they are that way

**A user is a GitHub account**, a person or a machine user (a bot). OATS
reads Git with the operator's own credentials, so **what an account can read
is its view of the workspace**: a member it cannot read contributes nothing
for it (`cannot-read`), and a user who can read a member but not the host sees
the **standalone** view (that member's souls only, with `oats.core`). A host
runs a workspace automation only while its `gh` is logged in as the
automation's `owner`. A messaging identity is separate: each instance gets its
own, in its soul's **default team**.

**The workspace** is one `oats-workspace.yaml` in a host repo (any member),
declared in Git so it is reviewed and the same for everyone. It lists members,
pins packages, declares shared teams and which souls may join them, sets
defaults, names knowledge stores and borrows external souls. Nothing is installed globally.

**Members and trust.** A repo is a member only when the workspace lists it
**and** its `oats-membership.yaml` points back. Why: whoever can push to the
member decides what its souls and capabilities are, the same trust as its
code, so membership is the trust decision and there is no per-tool approval.
Members are read at their **latest** default-branch state, not versioned.

**Packages** are the only versioned things: pinned in `packages:`, resolved by
`oats sync` to an exact commit and content fingerprint in `oats-lock.json`.
A package ships capabilities, souls and trigger templates; **one pin
versions all of it**. Declaring a package is the trust decision. Why two tiers: your repos move fast and you trust them; shared
tooling must not change under you. A repo can be a member **and** publish a
package; the two never merge (`from: <repo>` reads its latest `capabilities/`,
`from: package` reads the lock).

**Capabilities** are bundles of skills, an instruction inject, commands and
hooks. Three are **core capabilities** with exactly one slot each per soul:
knowledge (`oats.okf`), messaging (`oats.aweb`) and tasks (`oats.aweb-tasks`,
`oats.jira`, `oats.linear`), because an agent needs one memory, one address and one task
list. Everything else is additive; `oats.core` (operating inside OATS) is a
default almost every soul has. A capability comes `from: package`, `from:
<member repo key>` or, in a soul, `from: here` (its own repo or package). A
member capability marked `private: true` is **repo-owned**: listed, but usable
only by that repo's souls.

**Each workspace has a setup expert:** a soul that holds `oats.setup`. From
OATS 0.69.8 (`oats.framework` 1.18.0) it is the framework's package soul
`oats-setup-expert`, with `oats.setup`, `oats.onboarding` and
`oats.coordination-setup`, and its instance
is named `<workspace>-oats-setup-expert` (on a machine joining an existing
workspace, `<workspace>-<machine>-oats-setup-expert`; `<workspace>-oats-setup`
when a soul of the workspace already holds the first name, and no `--name`,
left to spawn, when a soul holds that one too or the name is too long). The
repository's `oats-getting-started` skill spawns it, and for a new workspace
writes no setup soul of its own. Before `oats.framework` 1.18.0, add one
like any soul (`/oats-workspace-config`). All its knowledge comes from this capability, so a workspace's
setup expert improves with the `oats.framework` pin, not by edits to a soul.
From OATS 0.61.0, `oats onboard` names it as the next step. It finds the
soul by what the soul's own `soul.yaml` declares, never by its name alone:
among the souls that declare `oats.setup`, the workspace's own soul named
`<workspace>-oats-setup-expert`, else `oats.framework`'s `oats-setup-expert`,
else the first by name. A workspace may already have an older setup soul
under another name, and that one serves the same way where the framework's
soul is not pinned. The OATS project's own workspace has two,
`oats-setup-admin`, and `oats-operator-expert`, which also holds the
operator knowledge; it pins `oats.framework`, so its onboard step names the
framework's `oats-setup-expert`.

**Souls** are durable roles: `souls/<name>/` in a member, in a package
(`<package>/<soul>`), or borrowed through `external:`. **Composition** is
`workspace defaults → the soul's own list`,
later wins; `off` drops a default and `<slot>: none` empties a core slot.
`oats inspect --soul <name>` reports why each core capability is there
(`layers.<slot>.from`: `soul` or `workspace`). A soul's
knowledge (the nodes it owns and reads) lives in an external knowledge base,
not in the soul.

**Teams organise; they never gate.** A team is a messaging-provider team
under a label: shared (the workspace file) or, only when the workspace says
`localTeams: true`, local (`oats-local.yaml`). An instance in two teams is a
bridge between them, so the teams a soul may join and its default team are the
organisation's decision, committed in the workspace file (`defaultTeam:`,
`souls:` keyed by pattern), closed by default: a soul no key matches gets its
default only. That prevents accidental joins and keeps the team set
reviewable; it does not stop a deliberate relay. An instance joins its default
team at spawn, and the soul's other teams are *eligible*, joined explicitly
(`/oats-teams`). A team adds no capabilities, grants no trust, restricts no
one and partitions no knowledge. The kernel reads these facts and edits the
local ones:

```bash
oats teams [--json]                                      # shared and local teams, the default, the workspace's souls:
oats teams add <label> --team <id> [--description <d>]   # a local team (localTeams: true); the first one becomes the local default
oats teams remove <label>
oats teams default <label>                               # the deployment's local default (localTeams: true)
oats soul teams <soul>|'*'                               # read only: a soul's default and teams, and which souls: key applied
```

**Instances** are incarnations of a soul on one machine: a **home** (its
instructions, task and state) and **`./work`** (per the soul's work mode:
`worktree`, `checkout`, `directory`, `workspace`, or `attached` at spawn). An
instance keeps the commits and package versions it was spawned with; `oats
status` shows **drift** when the member or pin moved since, and only a new
spawn picks it up. It was spawned by a person, by another instance (its
parent), or by an automation, with a harness (`pi`, `claude`, `codex`) and a
model.

**Automations** spawn or wake instances without a person. **Local** ones live
in this deployment's `oats-schedules.json`, run on this machine with its own
`gh`, and are machine-private. **Workspace** ones are committed
in a member (`oats-triggers/`, `oats-schedules/`, or a `*.oats-trigger.yaml` /
`*.oats-schedule.yaml` file) and
name **where** they run (`runsOn`, a host's `host.name`) and **as whom**
(`owner`, a GitHub account); only that host, logged in as that account, runs
them. One host timer per machine runs every due automation (`/oats-automations`).

**This machine** is the deployment directory: `oats-local.yaml` (which
workspace, host-owned settings such as paths and custody, clones, launch
configurations, souls disabled here, its `host.name`, its local `teams` and
`defaultTeam` (only with `localTeams: true`) and `triggers.disabled` /
`schedules.disabled`), `oats-lock.json` (written by `oats sync`), `agents/`
(the instance homes) and the host timer. None of it is in Git. Two more host
facts decide whether messages wake the agents at all:
- **Claude's managed settings** admit the aweb channel plugin, so that
  Claude homes start without a development prompt (`claudeChannelMode`).
- **The host wake broker** is aw's daemon, run as a per-user service. It
  wakes Codex homes, `delivery: session` homes and every joined team.

Nothing defaults either one safely. `/oats-host-delivery` teaches both, and
onboarding makes both choices.

## Where does X come from, why is X here, why can't I Y

| Question | Ask | Read |
|---|---|---|
| Which repos are in, and which are not and why? | `oats workspace status` | each member's state: `confirmed`, `not-listed`, `no-backlink`, `backlink-elsewhere`, `cannot-read` |
| Which package versions are in use? | `oats workspace status` | the locked packages (commit and integrity) |
| Which souls exist, and from where? | `oats souls` | origin (`member <repo> @ <commit>`, `package <id> v<version>`, external) and teams + default team |
| Why can't I see soul X? | `oats workspace status`, `oats souls` | its member is unconfirmed or unreadable for this account; its package is not pinned or synced |
| Which capabilities exist, and from where? | `oats capabilities` | origin (member or package), repo-owned marks |
| What exactly would soul X get? | `oats spawn X --preview` | modules at their commits, skills, merged `settings.<cap>` with their origins, `teams` and `defaultTeam` |
| Why does soul X have capability C? | `oats inspect --soul X --json` | `layers.<slot>.from`; for additive ones, compare the soul's own list with the workspace defaults |
| Why can't I spawn soul X? | `oats spawn X --preview` | the refusal code and path; `/oats-workspace-config` maps it to the fix |
| Which instances run here, and are they current? | `oats status` | each instance's soul source, modules and drift marks |
| What was an instance given, and why? | `oats inspect --home <abs home> --json` | recorded modules, payloads, `layers.<slot>.from` as recorded at spawn |
| Which teams does this deployment have? | `oats teams` | shared and local teams (label, team id), the default, `localTeams`, the workspace's `souls:` |
| Which teams can an instance of X join? | `oats soul teams X` or `oats spawn X --preview` | the soul's teams (with `via`) and the `souls:` key that applied; those other than its default are eligible |
| What runs automatically, and where? | `oats trigger list`, `oats schedule list` | local and workspace automations; for a workspace one, whether it runs here or why not |
| Would this trigger work on this host? | `oats trigger test <id>` | `gh` credentials, repo permissions, the soul resolving, the teams declared, what would fire |
| What is configured on this machine? | `oats doctor` | this deployment's local file and lock |
| Is Git ready for OATS on this machine? | `/oats-git-setup`, its check | SSH auth, a signed and signed-off commit GitHub shows as Verified, `gh auth status`, and the credential helper a Git without `HOME` would use |
| Will mail wake the agents on this machine? | `aw wake status --json`, `oats readiness --home <abs home> --json` | the broker running at the `aw version` version; no `wake-daemon-*`, `joined-team-poll-only` or `channel-dev-confirmation` the operator did not choose (`/oats-host-delivery`) |

Use `--json` when you parse; read `oats help` for any flag not shown here.

## Gotchas

- **Shared vs this machine.** Most confusion comes from mixing them. A shared
  change (Git) reaches every machine at its next `oats sync`; a host fact
  changes one machine only. Say which one you are talking about.
- **Absence proves nothing.** A soul missing from `oats souls` is usually a
  membership or access fact, not a deleted soul: check `oats workspace status`
  for that account first.
- **The workspace view is the remote, not a working copy.** A change is
  invisible to every `oats` read until it is on the default branch.
- **A running instance never changes under itself.** Explaining an instance
  means reading what it recorded (`oats inspect --home`), not the workspace as
  it stands now.
