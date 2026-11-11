# Knowledge

The **knowledge slot** gives a working soul durable, reviewed expertise:
decisions and their rationale, rejected alternatives, discovered limits. The
kernel owns slot selection, composition and command dispatch; the capability
owns its knowledge format, instructions and promotion procedure. The model is
in [Knowledge, instances and evolving expertise](knowledge-theory.md).

This is the operator guide for **oats.okf 6.0.2** (OATS **>=0.69.2**). Provider implementation and
recovery details belong to the [oats-okf README](https://github.com/awebai/oats-okf).
In 6.0 there is no knowledge harvester: a working instance proposes its own
knowledge as a pull request at its checkpoints (`oats okf propose`), and the
knowledge maintainer gates every merge.

| Surface | What it holds |
|---|---|
| Accepted Git or directory bases | Soul knowledge: OKF concepts in owned nodes. |
| `souls/<name>/okf.json` | The soul's stable owner and owned/read nodes (version 1), or the subjects it reads by default (version 2). |
| Instance home: `STATE.md`, `log.md`, `notes/` | The instance's working knowledge. |
| Instance home: `okf-harvest-policy.json` | Provider-written duty to propose, recorded at spawn (the file keeps its 5.x name), exposed by `oats okf status`; not publication authority. |
| Instance home: `proposals/<date>-<slug>/` | One proposal: clones of the owned bases, `proposal.md`, and once applied its publication record. Not accepted knowledge. |
| Bindings file and `stateDir` | Host base locations and consultation/binding state, not a proposal queue. |

## Setup

### Pin and select the package

```yaml
# oats-workspace.yaml (excerpt)
packages:
  oats.okf: v6.0.2
defaults:
  knowledge: { oats.okf: { from: package } }
stores:
  org: git:github.com/acme/knowledge
```

`oats sync` locks the package. `oats spawn <soul> --preview --json` shows the
resolved module and merged settings. Membership in the package's repository
does not supply the package capability: the workspace pin does.

A soul without knowledge says `knowledge: none`. `stores:` names workspace
repositories; oats.okf reads its **bindings file**, not that block, to locate
bases. Each deployment supplies host paths, for example:

```yaml
# oats-local.yaml (excerpt; replace the example paths)
settings:
  oats.okf:
    bindings-file: /absolute/okf/bindings.json
    state-dir: /absolute/okf/state
```

Upgrading from 4.x requires the ordered
[5.0 cutover](release-notes/v0.49.0.md#oatsokf-50-cutover--order-matters), not
just editing a version line. The package requires OATS >=0.69.2: its
`knowledge-maintainer` soul says `background: true`, which an older kernel
refuses. Upgrade OATS first, then the package. Each 5.x step is in
[oats.okf's CHANGELOG](https://github.com/oats-project/oats-okf/blob/v6.0.2/CHANGELOG.md).

**Upgrade to 6.0:** pin `oats.okf: v6.0.2` and run `oats sync`. Only new
spawns get `oats okf propose`, the 6.0 `okf-propose` skill and the
spawn-recorded duty. Existing homes keep their copied provider even after a
session restart; a stopped 5.x home can move with `oats instance upgrade`
(OATS 0.68.0 and later), and a home spawned under 4.x is refused with the
remedy to retire and respawn it. Harvester spawns stop: the stub soul
`oats.okf/knowledge-harvester`, kept until 7.0, refuses every spawn with
`E_REMOVED` and the fix. Harvesters already running keep their 5.x modules
and finish, or a person retires them. Then, by hand, from the deployment
(oats.okf's [Upgrading to 6.0](https://github.com/oats-project/oats-okf/blob/v6.0.2/README.md#upgrading-to-60)
has each step's commands):

1. Delete the harvester's launch preference, if any:
   `oats soul launch remove oats.okf/knowledge-harvester --plan`, then
   without `--plan`.
2. Delete every `--provider oats.okf harvest=…` spawn flag from the scripts
   and briefs that spawn instances; remove a leftover host `harvest` key with
   `oats okf setup --remove-legacy-settings --soul <soul>` (`--plan` first).
3. Add the `proposal-review` trigger beside `harvest-review`, and remove the
   old one once no 5.x harvester can open an `okf-harvest` PR
   ([Triggers](#triggers)).
4. Protect every Git base's accepted branch (pull requests only, merged by
   the knowledge maintainer's account), and give each proposing host
   branch-create access on the knowledge repository; optionally set
   `screen-terms-file` ([Settings](#settings)).
5. Retire the harvesters `oats status` still lists, once they have handed
   over; propose a retained one's claims with the operator form of
   `oats okf propose` ([the flow](#the-flow)).

Bindings, `okf.json` and `okf-base.json` need no change, and open
`okf-harvest` PRs stay reviewable.

### Bindings document

Capability-owned JSON at an absolute path; relative paths inside resolve
from the document's directory:

```json
{
  "version": 1,
  "stateDir": "./state",
  "bases": {
    "project": {
      "id": "project-knowledge",
      "kind": "git",
      "repository": "https://github.com/example/project.git",
      "root": "knowledge",
      "acceptedBranch": "main",
      "pr": { "repository": "example/project" }
    },
    "team": { "id": "team-knowledge", "kind": "directory", "path": "../team-knowledge" }
  }
}
```

- The alias (`project`) is local to the bindings and is named by souls'
  `okf.json`. Its `id` must match `okf-base.json` at the base root or reading
  that base fails with `E_BASE`.
- Git bases may use HTTPS, SSH or a durable local repository; `root: "."`
  means the whole repository. Embedded credentials are refused. Proposals
  are same-repository GitHub PRs from a new, create-only branch, through
  ordinary `git` and `gh`; there is no fork flow.
  Change a binding's `repository` to a plain URL only after every seat that
  reads it has been re-spawned on oats.okf 5.0.4 or later; a session restart
  does not update the copied provider.
- Directory bases need no Git and must not sit inside a Git worktree. They
  support consultation and explicit provisioning/migration, **not
  proposals**: `oats okf propose` skips a directory base and names the remedy
  (convert it to a Git base, or edit it in a reviewed change).
- Paths are physical and nonoverlapping: state is outside every base and
  instance home; the bindings document is outside state and bases.
- `cron` and `tz` are removed: the provider schedules nothing.
- Protect each Git base's accepted branch so that only a pull request the
  knowledge maintainer merges changes it: the maintainer can gate only what
  cannot bypass it. `oats okf bases` reports `protection: enforced | none |
  unknown` per Git base, read-only.
- A bad configured base blocks a knowledge-slot spawn; the error names the
  alias. Spawning never bootstraps an empty accepted base as a fallback.

### Settings

The knowledge capability declares five host settings:

| Setting | Default | Meaning |
|---|---|---|
| `bindings-file` | required | Absolute path to the bindings document. |
| `state-dir` | required by portable binding preparation | Absolute host-owned state location, never derived from an instance home. |
| `git-timeout` | `600` | Seconds allowed for a remote Git operation. |
| `consult-max-age` | `300` | Maximum cached accepted-commit age before refetch; `0` always refetches. |
| `screen-terms-file` | none | Optional (6.0): absolute path of a host file, one term per line; `oats okf propose` refuses outgoing content holding a term (rule `host-term`, by location only). It only adds refusals. |

Host `harvest`, `harvest-runtime` and `harvest-model` are removed, including
explicit `harvest: off`. A 4.x **recorded manifest default** is ignored by
5.0 readers as nobody's decision, not reinterpreted as an opt-out. Explicit
removed keys still refuse and name the fix. A host or spawn `publish` refuses
too: only the soul opts out ([The soul's opt-out](#the-souls-opt-out)). There
is no proposal runtime or model to choose: the instance proposes itself.

## The soul's okf.json

Every working soul using oats.okf has `okf.json` beside `soul.yaml`:

```json
{ "version": 1, "owner": "domain-expert", "owns": ["project/expert"], "reads": ["project/steward", "team/operations"] }
```

`owner` is the stable owner ID named by the base metadata. `owns` lists
`alias/node` proposal destinations; `reads` is the starting consultation
context. Neither is an access-control list: every configured base is
readable. Missing declarations, base metadata or indexes refuse spawn;
legacy soul-local knowledge needs explicit migration, never silent copying.

**Version 2 (6.0)** binds a soul to **subjects** on a bridged base, one with
the subject layout (its `okf-base.json` lists the reserved nodes `claims`,
`subjects` and `verdicts`):

```json
{ "version": 2, "subjects": ["system/oats-kernel", "workstream/operations"] }
```

Each entry is `<kind>/<slug>`, a subject that exists on a bound base. They
are the soul's reading defaults, with no owner, `owns` or `reads`: spawn and
readiness resolve them (`E_CONFIG: unresolved subject: <ref>`; a plain base
answers `E_CONFIG: base <alias> has no subject layout`), and the spawn brief
lists one line per subject with its claim counts. Such a soul writes its
claims under `claims/`, each `about:` one or more subjects. Version 1 keeps
working on a bridged base. A soul moves to version 2 once its base is
bridged.

`oats okf init` provisions a new directory base with `--confirm`, or stages a
Git base with `--output` for reviewed delivery. Existing knowledge is never
overwritten by initialization.

## The soul's opt-out

**There is no host switch.** The sole choice is the soul's opt-out:

```yaml
knowledge: { harvest: off }   # from 6.0 also spelled publish: off
```

That soul keeps consultation and working-memory guidance but has no duty to
propose. The shared IMPORTANT block and compulsory skill pointer still ship,
with an explicit exception; the provider's spawn-recorded answer says `off`.
Independently, `oats okf propose` refuses that soul's homes (`E_OPTED_OUT`),
also reading the soul's own text. Absence gives the normal proposal flow.
A soul's `harvest: on` is not a replacement switch, and a soul `publish`
other than `off`, or a soul `knowledge.propose` key, refuses the spawn
(`E_CONFIG`). Host cleanup never changes the soul declaration.
`knowledge: none` removes the layer entirely.

## Knowledge operations

### The flow

1. **Consult and keep instance knowledge current.** Read accepted soul
   knowledge at task start, after compaction and before decisions. Keep
   `STATE.md`, `log.md` and `notes/` up to date as work happens. The
   capability's **IMPORTANT** inject block makes this upkeep and proposing at
   each knowledge checkpoint a duty; reading **okf-propose** is compulsory.
   Neither duty depends on TASK.md. Run `oats okf status` from instance home
   to learn the duty recorded at spawn: `on` means follow the skill, `off`
   means no proposal, and `unknown` or an error means stop and report, never
   infer permission or edit the record. Working instances never push to an
   accepted branch or merge their own proposals.
2. **Propose at each knowledge checkpoint.** The checkpoints are a PR handed
   over for review and a finished task. In a long-lived role whose task
   never finishes (a maintainer, an expert holding an area, a support desk),
   they also include a feature ready, a release or deploy shipped, and a
   direction decision taken with the human. A commit, a review round, a new
   head of the same PR and each decision made while working are not
   checkpoints: those are captured in `notes/`, and the next checkpoint
   carries them. First update state, log and relevant notes. Apply
   `knowledge-theory` and search accepted knowledge (`oats okf search`, then
   `cat`): already accepted with nothing to add means no proposal. Make **one
   proposal per checkpoint, carrying only what no earlier proposal carried**,
   and record every checkpoint in `log.md`, either with its proposal's PR
   URLs or with `nothing to propose` and the reason. Claim only for owned
   nodes (or, for a version-2 soul, in `claims/` on its subjects); a lesson
   for a node the soul only reads is named in one line in its hand-back for
   that node's owner.

   The instance proposes itself, from its home, in three steps:

   ```sh
   oats okf propose --plan --slug <slug>
   oats okf propose --check --slug <slug>
   oats okf propose --apply --slug <slug> --digest <digest>
   ```

   `--plan` clones every Git base the soul owns, at its accepted branch, into
   `proposals/<date>-<slug>/work/<alias>`, writes the skeleton
   `proposal.md` (What, Why, Evidence, Backing notes), and prints the write
   surface (the owned nodes and the base root `index.md`) and the open
   `okf-proposal` and `okf-harvest` PRs: duplicate candidates. The instance
   writes the concepts in the clone with its own file tools and fills
   `proposal.md`. `--check` validates the proposed tree, checks every path
   against the write surface, hashes the named notes, screens everything
   that would leave the host and prints the complete outgoing diff, the
   commit text, the PR body with its provenance block and a digest; nothing
   remote changes, and the instance reads that diff once as a reviewer would.
   `--apply` with that digest commits, pushes a new
   `okf-proposal/<date>-<uuid>` branch (create-only, never the accepted
   branch), labels it `okf-proposal` and opens one PR per changed base. One
   attempt per proposal: a publication error (`E_BASE_MOVED`,
   `E_PUSH_UNCERTAIN`, `E_GH`, `E_PR_UNCERTAIN`) is reported, never retried,
   and a remote branch or PR may exist after an uncertain one. The instance
   records the PR URLs in `log.md` and goes back to work: it never shepherds
   the PR, and nobody waits for it to merge. oats.okf's README has every
   refusal and its remedy.

   **The operator form,** for a source that retired without proposing, runs
   the same three steps from the deployment on its retirement recovery:
   `oats okf propose --home <retirement recovery directory> --soul <soul>
   --plan --slug <slug>`, then `--check` and `--apply` with the same `--home`
   and `--soul`. The proposal directory is made in the copied home, and the
   provenance names the form.
3. **Review.** A separate `oats.okf/knowledge-maintainer` reviews each PR
   and **gates every merge**: it verifies each claim against the evidence it
   cites, judges it by the promotion test, and merges, amends and merges, or
   closes it, with a verdict bound to the exact head. The `proposal-review`
   trigger spawns it ([Triggers](#triggers)); where none is installed, the
   proposer may spawn one, a call and not a station:

   ```sh
   oats spawn oats.okf/knowledge-maintainer --task "Review knowledge-base PR <url> at <head>. Load the knowledge-review skill first." --relation unrelated
   ```

   A PR is not accepted knowledge until merged. Human-accepted decisions are
   not silently superseded: the review never parks a PR, and such a
   supersession merges only with the human's acceptance cited (checked when
   the record is on GitHub, otherwise recorded as source-reported), and is
   closed without it
   ([awebai/oats-okf#118](https://github.com/awebai/oats-okf/issues/118)).
   The maintainer reports to no one: the proposer reads the PR.

The promotion test belongs to
[What deserves to become knowledge](knowledge-theory.md#what-deserves-to-become-knowledge),
not a kernel mechanism. The maintainer soul has `knowledge: none`; working
souls also receive the curated theory skill.
The [older knowledge-operations design](design/2026-09-26-okf-knowledge-operations.md)
is historical 4.x context, not instructions for operating 6.0.

### What a proposal leaves out

Secrets, credentials, private paths and verbatim third-party messages are
left out. So is personal data, in the same sentence at every place an agent
is told what to leave out (the capturing instance, the proposing skill when
it writes and when it reads its outgoing diff, and the maintainer's review):

> Never include personal data about people outside the team (clients,
> correspondents, any other third party): a name, a contact detail, or
> anything else that identifies a person, including detail derived from
> correspondence. Keep the lesson and leave the person out. Naming the
> author of a published source you cite is fine.

The sentence also covers the names provenance publishes as written: note
file names, task refs and instance names. These exclusions are instructions
to agents and guarantee nothing. The propose command hashes the evidence it
names but does not judge its content. A bounded content screen runs over
everything that would leave the host before every push, comment and merge,
and the host's `screen-terms-file` can add terms to it; a clean screen is not
proof. The proposer reads its outgoing diff before the push; the maintainer,
the second reader, reads the already-pushed pull request. The write surface,
the provenance checks and the soul's opt-out are enforced in code; none is a
privacy guarantee. The opt-out ([The soul's opt-out](#the-souls-opt-out)) is
per soul and covers that soul's own proposals, not what its instances write
to other seats. A soul whose work is reading third-party correspondence
should opt out.

### Triggers

Only **PR review** is triggered. Use the package template
`oats.okf:proposal-review` (label `okf-proposal`) in a workspace trigger
file, or
`oats trigger add --from oats.okf:proposal-review --set repo=github.com/<owner>/<repo>`.
Through 6.x, `oats.okf:harvest-review` watches only the 5.x label
`okf-harvest`. The kernel requires every label a trigger names, so each
template watches one: keep `harvest-review` beside `proposal-review` only
while a 5.x harvester may still open an `okf-harvest` PR, then remove it.
The `okf-trigger-setup` skill explains setup and testing. Validate the review
route with `oats trigger test` before relying on automated review. Without
the trigger, proposal PRs wait for a human reviewer or a maintainer the
proposer spawns.

There are no per-source jobs or host-timer installation steps in this
provider. See [Knowledge proposal review](schedules.md#knowledge-proposal-review),
[Triggers](schedules.md#triggers) and
[Workspace triggers and schedules](schedules.md#workspace-triggers-and-schedules).

### Who gets which okf skills

| Capability | Composed into | Skills |
|---|---|---|
| `oats.okf` | Working souls it serves | [`okf-consultation`](../mirrors/oats-okf/skills/okf-consultation/SKILL.md), [`okf-instance-knowledge`](../mirrors/oats-okf/skills/okf-instance-knowledge/SKILL.md), [`okf-propose`](../mirrors/oats-okf/skills/okf-propose/SKILL.md), `knowledge-theory`, `okf-authoring` |
| `oats.okf-maintenance` | `oats.okf/knowledge-maintainer` | `knowledge-theory`, [`knowledge-review`](../mirrors/oats-okf-maintenance/skills/knowledge-review/SKILL.md), `okf-authoring`, [`okf-trigger-setup`](../mirrors/oats-okf-maintenance/skills/okf-trigger-setup/SKILL.md) |

The capability's **IMPORTANT** inject block gives the duty and compulsory
pointer; **okf-propose** holds the procedure. These shared texts also reach
opted-out souls, with the explicit exception and provider status answer.
No TASK brief contains proposal direction. Until 7.0 the package also ships
`oats.okf-harvest` and the soul `oats.okf/knowledge-harvester` as stubs, with
no skills or instructions: the soul's required spawn hook refuses every spawn
with `E_REMOVED`, naming the fix.

## Inspection and operator commands

From an instance home, `oats okf …` runs its copied module and recorded
settings. Pinning a new package does not replace those modules, hooks,
skills or briefings; even the old home's readiness/binding checks keep its
old code. Respawn homes that should adopt the new proposal flow.

From the deployment directory (holding `oats-local.yaml`), with neither
`OATS_INSTANCE_HOME` nor `OATS_HOME` set, pass `--soul <name>` or use the
first soul providing that namespace. The kernel resolves and runs its
locked module with the selected soul's merged payload. An in-home command
cannot select a different soul (`E_HOME_MISMATCH`). An unlocked package is
`E_PACKAGE_MISSING` until sync. See [capability dispatch](capabilities.md).

### Consult

```sh
oats okf bases
oats okf index [--base ALIAS] [NODE]
oats okf cat --base project /expert/decisions/retry-policy.md [--from PATH]
oats okf ls --base project /expert/lessons
oats okf links --base project /expert/decisions/retry-policy.md
oats okf search backoff [--base ALIAS | --all] [--node NODE] [--regex] [--case-sensitive]
```

On a bridged base, the subject verbs read the committed indexes by subject:

```sh
oats okf subjects [--kind KIND]
oats okf subject KIND/SLUG
oats okf claims --about KIND/SLUG [--type TYPE] [--kind KIND]
oats okf index [KIND/SLUG]
oats okf verdicts --check CLAIM-FILE
```

A plain base answers them with `E_USAGE: base <alias> has no subject layout`.
Commands accept `--json` and `--fresh`. Run from the home, or select a live
home with `--home PATH` from an operator scope and the appropriate `--soul`.
There is no `--source` descriptor path, including after retirement. Paths
are rooted in the base, never outside it. A failed fetch may serve cached
accepted bytes marked stale. `read` and `refresh` remain removed: use `cat`
and `index`. The consultation skill teaches navigation and citation.

### Read the duty to propose

```sh
oats okf status --json
```

The provider's answer is `result.harvest: "on"` with `reason: "default"`, or
`"off"` with `reason: "soul-opt-out"`; from 6.0 `result.publish` repeats the
same value under its new name. It reads only home-local spawn state,
not the network, bases, TASK.md or a soul file. Missing state is `"unknown"`
with `reason: "spawn-state-missing"`; malformed or linked state refuses.
Neither unknown nor failure permits a proposal. Report it and respawn with
the current provider; never hand-create a policy or reinterpret later
settings as the spawn decision. `--home PATH` selects an explicit home.
This answer is instruction state, not publication authority: `oats okf
propose` reads it and refuses `off` and `unknown` homes itself.

### Inspect

```sh
oats okf inspect --json
oats okf inspect --home /absolute/instance-home --soul domain-expert --json
oats operation run knowledge:inspect --home /absolute/instance-home --json
```

The view contains the declaration, configured bases and that home's working
`STATE.md`, `log.md` and Markdown notes. Each document has a 256 KiB preview
cap (`truncated: true` beyond it), preserving UTF-8 boundaries. It invents
no capture/processing/acceptance receipts and has no retired-source view.
`oats okf bases` reports accepted-state freshness and validity separately.

### Operator-level commands

From the deployment, with `--soul <name>`:

| Command | Purpose |
|---|---|
| `propose --home <recovery> --soul <name> (--plan \| --check \| --apply) --slug <slug>` | Propose for a source that retired without proposing ([the flow](#the-flow)). |
| `setup --remove-legacy-settings [--plan] [--json]` | Delete only explicit legacy host harvest keys; guard-exempt, plan read-only. |
| `init --base ALIAS --nodes FILE (--confirm \| --output PATH)` | Provision a directory base or stage a Git proposal. |
| `migrate …` | Explicitly migrate legacy soul-local knowledge into a base. |
| `unlock --lock PATH --token TOKEN` | Release the specified dead local process's directory-base lock. |

### Completion and recovery

`harvest`, `run-source`, `complete`, `retry`, `harvest-status`, old source
selectors and harvest setup switches return actionable removal errors, as
does a spawn of the harvester stub. There is no completion/settlement engine:
a proposal's publication record stays in its proposal directory. Existing 4.x private
inputs and open PR obligations must be resolved explicitly under the old
provider before the pin; they are not deleted or re-imported by 5.0. Follow
the [ordered cutover](release-notes/v0.49.0.md#oatsokf-50-cutover--order-matters), including the host cleanup
**after** 5.0 sync and **before** new spawns.

## Without a knowledge capability

`knowledge: none`, on a soul or as the workspace default, is valid: no OKF
state, instructions or source. Another capability may fill the slot with
its own model ([authoring guide](knowledge-capability-authoring.md)).
Switching slots migrates and erases nothing.
