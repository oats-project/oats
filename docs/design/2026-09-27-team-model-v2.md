# Team model v2: shared and local teams, the default team, and membership per deployment

**Status:** superseded in part by [team model 3](2026-10-02-team-model-3.md) (kernel 0.38.0): which teams a soul may join and its default team are committed in the workspace's `souls:` and `defaultTeam`, and local teams need `localTeams: true`; `souls.teams`, `souls.default` and the `oats soul teams` edits below are removed. The rest stands. Decided and implemented (kernel 0.30.0, feature `team-model-2`). This record decides where teams, the default team and team membership live, how the kernel resolves them, and what the kernel hands a messaging provider. The reference pages ([workspaces.md](../workspaces.md#teams), [capabilities.md](../capabilities.md#teams-in-the-provider-environment), [desktop-cli-api.md](../desktop-cli-api.md#team-model-v2-feature-team-model-2-oats-0300-replaces-feature-teams)) win on operator-visible behaviour.

## Why

Team membership is **local to each deployment**, over shared repositories and souls. Two people running the same souls from the same repositories have different sets of teams: some are shared (both map the label to the same provider team), some are personal, and each has their own default. Membership therefore never lives in a committed file, and every soul, member or package, is treated the same.

What is shared is a fact, not a choice: a shared team's provider id is the same for everyone. That fact is committed once; everything personal is local.

## The model (option B)

The chosen model is **option B: shared facts committed, personal choices local**. The committed `oats-workspace.yaml` `teams:` declares the shared teams with their provider ids; each deployment's `oats-local.yaml` declares its local teams, its default team and all membership.

### Where it lives

Committed `oats-workspace.yaml` (shared teams only; edited by PR):

```yaml
teams:
  oats: { team: oats:example.aweb.ai }        # a shared team: the same provider id for everyone
```

Local `oats-local.yaml` (the deployment's per-machine file, never committed):

```yaml
teams:
  builder-oats: { team: builder-oats:ana.aweb.ai }   # a local (personal) team: label → provider id
defaultTeam: builder-oats
souls:
  disabled: [...]
  teams:                        # the extra teams each soul's instances MAY join here
    "*": [oats]                 # every soul
    oats-expert: [oats]         # one soul: its bare name, or <package>/<soul> for a package soul
  default:                      # an optional per-soul override of defaultTeam
    oats-expert: oats
```

- **`teams.<label>`** is `{ team?, description? }` in the committed file and `{ team, description? }` locally. These are the only places a provider team id is written. A shared team without `team` is declared but not yet created: readiness `team-unmapped`, a failure when it is the default, a warning otherwise.
- **A label in both files** is `team-label-collision`, a readiness warning and never a spawn refusal: the shared definition wins, and the fix is renaming the local label. A teammate's PR adding a shared team never breaks another deployment on sync.
- **`defaultTeam`** is the team every instance of this deployment lives in: its default-team identity. It names a label from either file. `oats teams add` of the first team sets it.
- **`souls.teams`** lists the teams a soul's instances are eligible to join here: `"*"` for every soul, and a soul's own entry adds to it. Eligible teams are offered, never auto-joined.
- **`souls.default`** overrides `defaultTeam` for one soul; it must be one of that soul's teams (`E_TEAM_NOT_ELIGIBLE`).
- **An undeclared label** anywhere is `E_TEAM_UNKNOWN`: a spawn, preview or `inspect --soul` refusal, and a readiness item.
- **Messaging active and no default** is `E_TEAM_UNCONFIGURED` (a readiness failure). There is no guessed team and no fallback to a provider's own active team.
- **A label never gates, restricts, changes trust or partitions the knowledge store.**

### Not part of the model

These keys are refused with `E_WORKSPACE_SCHEMA` (reason `removed-key`), naming the replacement; there are no aliases:

- `oats-workspace.yaml` `messaging.byTeam` (the id is `teams.<label>.team`) and `defaults.byTeam` (capabilities compose from the committed workspace and the soul only, so composition is the same for everyone);
- `soul.yaml` `team:` and `oats-membership.yaml` `team`;
- the "primary" label;
- the messaging provider's own `team` setting, at every layer.

### Resolution

- `defaultOf(soul) = souls.default[soul] ?? defaultTeam`.
- `teamsOf(soul) = {defaultOf(soul)} ∪ souls.teams["*"] ∪ souls.teams[soul]`, each label resolved through `teams.<label>`. The deployment default is among a soul's teams only when it is that soul's default or the soul lists it.
- A soul's teams are rows `{label, team, default, from: "shared"|"local"}`, the default first, then by label; its default is `{label, team, from: "deployment"|"soul"}`. The spawn preview, `inspect --soul`, `oats souls` and readiness report them; `instance.json` records them at spawn.
- **Changing `defaultTeam`** does not move running instances (their default-team identity is fixed): readiness `--home` warns `default-team-changed` until respawn.

### At spawn, and live

- **At spawn an instance joins its default team only.** Every other eligible team is offered: the spawn's `join=<labels>` provider setting (a trigger's `spawn.teams` becomes it), and checkboxes in the Desktop spawn dialog. Each joined team gets its own identity.
- **Later**, the provider's per-instance join and leave verbs opt one instance in or out of an eligible team. The default team is the instance's identity and is not left.
- **Live rule:** a joined team that is no longer eligible (removed from the soul's list, or the team removed) is left on the next live read. A newly eligible team is offered, never auto-joined. Nothing else is undone.

### Verbs

The kernel verbs edit `oats-local.yaml` in place; they never call a provider, clone, or open a PR.

```
oats teams [--json]                                   # this deployment's teams, ids, the default, problems
oats teams add <label> --team <id> [--description d]  # declare a local team
oats teams remove <label>                             # a local team nothing references
oats teams default <label>
oats soul teams <soul>|'*' [--add a,b] [--remove a,b] [--default <label> | --clear-default]
```

- `oats teams add` of a label already declared in either file is `E_TEAM_EXISTS`.
- `oats teams remove` of a label still referenced (`defaultTeam`, `souls.teams`, `souls.default`) is `E_TEAM_IN_USE`, naming every reference; there is no cascade. A shared label is not removable here (`E_TEAM_SHARED`: it is edited by PR).
- `oats soul teams` with an unknown label is `E_TEAM_UNKNOWN`; a `--default` outside the soul's teams after the write is `E_TEAM_NOT_ELIGIBLE`; `--default` with `'*'` is `E_BAD_ARGS`.
- The Desktop offers the same controls, labelled "on this computer": the deployment's teams and default, and a soul's teams here.

### Onboarding

Setup is the messaging provider's act, run by a human at setup time, never at spawn, mint, retire or wake. OATS holds no human login. The provider's setup is expected to:

- create the account and the first team when none exists, and record it locally with `oats teams add` (which makes it the default);
- create a new **local** team at the provider, then record it with `oats teams add <label> --team <id>`. A local team is never declared without an existing id;
- for a **shared** team declared without an id, let its owner create it and print the exact line to commit (`teams: { <label>: { team: <id> } }`), by PR; setup never edits the committed file;
- join an **existing shared** team through its owner's invite;
- normalize a label to the provider's team-name rules rather than passing it raw; the local mapping, not the name, is the truth.

## The kernel ↔ provider contract

**Environment** (every provider context: lifecycle hooks, home commands, operations and readiness checks). Teams travel beside a provider's settings, never inside them.

- `OATS_DEFAULT_TEAM`: the soul's default label. `OATS_DEFAULT_TEAM_ID`: its provider id. `OATS_DEFAULT_TEAM_FROM`: `deployment` (`defaultTeam`) or `soul` (`souls.default`).
- No default configured: none of the three is set. An unmapped default: `OATS_DEFAULT_TEAM` and `OATS_DEFAULT_TEAM_FROM` are set, `OATS_DEFAULT_TEAM_ID` is not.
- `OATS_TEAMS`: JSON `[{label, team, default, from: "shared"|"local"}]`, every **mapped** team the soul may be in here, the default included (`default: true`), default first, then by label. Eligible to join = the rows with `default: false`. Unset when a home's teams are unknown (none recorded and unreadable now).
- `OATS_TEAMS_SOURCE`: `live` (the workspace and `oats-local.yaml` read now, or a fresh resolution) or `recorded` (the spawn-time record in `instance.json`). **A provider leaves a joined team only on a `live` list**: a recorded list lacks every change since the spawn.
- Live reads happen where teams are acted on: a home's launch hook (`oats session start|restart`), its messaging module's commands and operations, `oats inspect --home` and `oats readiness --home`. Every other context gets the recorded teams. A scheduled wake's session start uses the recorded teams, so it leaves nothing.
- The pre-0.30 names `OATS_TEAM_LABEL`, `OATS_TEAM_LABELS` and `OATS_TEAM_ID` are always unset.

**What the messaging provider does with it:**

- mint an instance's default-team identity from `OATS_DEFAULT_TEAM_ID`, and join the other eligible teams only when asked (`join=` at spawn, or its per-instance verbs);
- refuse the spawn, naming the problem, when no default is configured or the default is unmapped;
- keep one identity root per team and mint each identity from that team's root, never from whatever team a root happens to have active; report a declared team with no member root as its own readiness problem;
- make a leave caused by a live read visible: a warning in the hook or command output, a `left: [{label, team, at, reason: "no-longer-eligible"}]` list (the last 20) in its teams document, and the instance's events (`oats instance events`). There is no acknowledge state, and readiness does not nag;
- report its teams document with `defaultTeam` in exactly the kernel's shape, `{label, team, from}`.

**Kernel verbs are config only.** `oats teams add | remove | default` write `oats-local.yaml` `teams` and `defaultTeam`; `oats soul teams` writes `souls.teams` and `souls.default`. A provider's setup records what it created by calling `oats teams add` and `oats teams default` through `OATS_CLI_BIN`. Joining a shared team's membership is a provider act; there is no kernel `oats teams join`.
