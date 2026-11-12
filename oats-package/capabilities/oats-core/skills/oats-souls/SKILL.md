---
name: oats-souls
description: >-
  Use when finding which souls the workspace offers and where they come from,
  telling a soul from an instance, reading a soul's definition, choosing how a
  new instance relates to you (child, parent, sibling), naming an instance, or
  proposing a new soul. Part of oats.core, day-to-day operation from inside an
  instance; running and inspecting instances is `/oats-operate`, and the setup
  and config of an OATS workspace is oats.setup.
---

# Souls, discovery and relations

A **soul** is a durable role definition kept in Git: `souls/<name>/` in a
member repository of the workspace (or in a pinned package, or borrowed from
another repository through the workspace's `external:` list), holding `soul.yaml`, `AGENTS.md` (its
canonical instructions), `CLAUDE.md → AGENTS.md`, optional `skills/`, and
whatever files its core-capability providers read (each provider's own
skill says which). An **instance**
is one incarnation of a soul, spawned into its own home for a task. Many
instances of one soul can run at once; each is fixed to the soul commit it was
spawned from.

## Find souls

```bash
oats souls                   # every soul of every confirmed member, with origin and teams
oats souls --json
oats workspace status        # which members are confirmed (an unconfirmed member contributes no souls)
```

Each row names the soul, its origin (`member <repo> @ <commit>`,
`package <id> v<version>`, or an external soul pinned by the workspace), its
teams and default team on this deployment, and its work mode. A **package soul** is named
`<package>/<soul>`; the bare name works unless two souls share it, in which
case `E_SOUL_AMBIGUOUS` lists the qualified names to use.
Souls are discovered **at the member's latest state** over the Git remote; no
local clone is needed to list or spawn them (only a soul's work target needs
a clone).

What discovery does not show, on purpose:

- **Souls of a repository that is not a confirmed member.** Membership is
  reciprocal: the workspace lists the repository and the repository's
  `oats-membership.yaml` names the workspace back. A soul left outside
  `souls/<name>/` is invisible.
- In the **standalone view** (the operator can read a member but not the
  workspace host) only that member's souls appear, with `oats.core` as their
  only package.

## Read a soul's definition

```yaml
schemaVersion: 2
name: release-manager                 # must equal the directory name
description: Cuts, verifies and announces releases.
work: worktree                        # worktree | checkout | directory | workspace
capabilities:
  release-tooling: { from: here }     # this soul's own repository
  acme-deploy: { from: package }      # a package the workspace pins
  house-style: off                    # drop a workspace default
```

A soul says **where** each capability comes from, never which version: the
workspace's `packages:` pins versions once. Workspace defaults fill the rest;
`oats spawn <soul> --preview` shows the exact result — modules, commits,
skills and the merged provider settings — without creating anything.

A soul file names no team. Which teams a soul may join, and its default
team, are the organisation's decision, committed in its workspace
(`oats soul teams <soul>` shows the result); teams organise messaging and never grant or
restrict anything (see `/oats-operate`, "Teams to join").

## Relations: what the new instance is to you

Spawn only when your task, your human or your soul's capabilities say so; a
child your capabilities call for (a developer's reviewer, an expert's
developers) needs no human's approval. When you do, declare what the new
instance **is to you** — the roster groups related instances by these links:

- **child** — `--parent "$OATS_INSTANCE"` (or `--relation child --relative-to
  <you>`): it works **for** you. A coordinator spawning the developers of its
  feature; a reviewer spawning a helper for its own review.
- **parent** — `--relation parent --relative-to <you>`: it oversees **you**;
  your recorded lineage is re-pointed under it. Spawning a maintainer to
  review your own pull request.
- **sibling** — `--relation sibling --relative-to <you>`: a peer in your
  cluster, enlisted for related work.
- **unrelated** — no flags: work with no connection to yours; it appears
  top-level.

An **attached** work mode always makes the new instance a child of the work
tree's owner; relation flags are refused there. A soul's own instructions or
your task briefing take precedence over these defaults. When the relation is
unclear, ask your parent or the agent that gave you this task; ask your human
only when no agent can say.

## Name the instance

Name an instance `<descriptive>-<role>`, with `--name`:

- **Descriptive:** a few lowercase kebab-case words for what this instance
  does (`desktop-improvements`, `release-0-26`), not an opaque number.
- **Role:** the new instance's role in your coordination, the word your
  coordination uses for it: your landing rules and your coordination skills
  name the roles, and a coordination template's spawn command gives one
  (`lead`, `developer`, `reviewer`, `maintainer`). With no coordination, one
  word for what the instance does in its task (`helper`, `auditor`).
- **At most five words** in all.
- **Nothing is appended:** not the soul's name, not its last word. The soul is
  shown beside the instance's name.
- So a lead's developer for the Desktop improvements is
  `oats spawn oats-desktop-developer --name desktop-improvements-developer`,
  not `--purpose desktop-improvements` (which gives
  `oats-desktop-developer-desktop-improvements`), and the lead of that effort
  is `oats spawn oats-engineering-expert --name desktop-improvements-lead`.

A task you write for a spawn says the new instance's role in its first lines
("You lead …", "You are the developer for …"). A suggested name
(`oats spawn --suggest-name`, the Desktop's empty Name field) is a model's
`<descriptive>-<role>` read from the task text, and it finds the role there.

`--name` is used exactly as given: it must be a slug, at most 64 characters,
and not a soul name. A name built this way can be a soul's name
(`code-reviewer`): add a word. An explicit `--name` in use is refused,
never suffixed.

Spawn's `--purpose <slug>` names the instance `<soul>-<slug>` instead,
derived from the soul, so a script or automation that knows only the soul
and a purpose can use it: schedules and triggers name their runs this way.
Don't use it to name an instance you spawn. It is not exact: a derived name
in use gets `-2`.
`--name` and `--purpose` do not combine. Without either, the kernel numbers
the instance.

Names are unique across the deployment. Never put secrets, user data or
volatile task detail in a name — with a messaging capability the instance
name is also its address.

## Propose a new soul

There is no command that creates a soul. A new soul is a reviewed change to a
member repository: add `souls/<name>/` with `soul.yaml` (`name`,
`description`, `work` required), a canonical `AGENTS.md` and the
`CLAUDE.md → AGENTS.md` link, commit it on a branch in your work tree and
open a pull request. Once merged it is discoverable at the member's latest
state; `oats spawn <name> --preview` verifies it resolves.

A soul may say what its role should run on with `launch: { harness, model? }`
(0.30). Each machine overrides it in `oats-local.yaml` `souls.launch`, and
spawn flags win over both; `oats spawn <name> --preview` shows the effective
launch and which layer chose it (`launch.from`, `launch.at`). Commit a soul's
`launch:` only once every deployment of the workspace runs 0.30, because 0.29
refuses the key. A changed preference reaches an existing home only through
`oats session restart --reselect-launch` or a respawn.

From OATS 0.69.2, a soul may also say `background: true`, so the clients list
its new instances under their Background section: presentation only, the
role's default place.
`spawn --background` / `--no-background` win over it, and
`oats instance background <instance> on|off` moves an existing instance. A
soul edit never moves one. Commit a soul's `background:` only once every
deployment of the workspace runs OATS 0.69.2 or later (feature
`instance-background` in `oats version --json`): earlier kernels refuse the
key, and the `--background` and `--no-background` flags.

Changing the workspace itself (its members, defaults, teams or pins) is
workspace setup and config, not something a soul proposal does.

Keep a soul universal: role, boundaries and workflow — never machine paths,
accounts, team ids or task state. Those live with the deployment
(`oats-local.yaml`, spawn-time `--provider` values) or in the instance's own
files.
