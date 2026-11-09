---
name: oats-teams
description: >-
  Use when declaring a team (shared in oats-workspace.yaml, or local with
  `oats teams add` when the workspace allows local teams), choosing the
  workspace's or a soul's default team, deciding which teams a soul may join
  (`souls:` in oats-workspace.yaml, read with `oats soul teams`), deciding
  which messaging team an instance joins, joining or leaving a team at spawn
  or later, or diagnosing E_TEAM_UNKNOWN, E_TEAM_NOT_ELIGIBLE,
  E_TEAM_UNCONFIGURED, E_TEAM_IN_USE, E_TEAM_SHARED, E_TEAM_EXISTS,
  team-unmapped, team-label-collision, default-team-changed,
  team-soul-unknown, local-teams-closed or a removed `souls.teams` /
  `souls.default` in oats-local.yaml (upgrading from 0.36). Also when an old
  config still has messaging.byTeam, defaults.byTeam or a soul/membership
  `team:`, and when someone expects a team to restrict or grant access (it
  never does). Part of the setup and config of an OATS workspace (oats.setup);
  day-to-day operation inside an instance is oats.core.
---

# Teams: configuration and eligibility

For the installed contract and rationale, see `docs/workspaces.md` (“Teams”)
and `docs/design/2026-10-02-team-model-3.md` under `oats root`.
These cards are self-contained for execution. Teams route messages; they never
restrict capabilities, grant trust, or partition knowledge.

## Inputs and version boundary

Use the authority and policy inputs already selected through `/oats-onboarding`:
`D` is the absolute deployment path, `S` the resolved soul, `L` the selected
label, and `T` the provider's canonical team ID (`name:namespace` for aweb,
not an internal UUID). In commands below, substitute those slots with quoted
values. Run deployment commands from your instance home with `--dir D`.
Shared edits target the selected workspace repository's `oats-workspace.yaml`;
local edits target `D/oats-local.yaml`.

Every card requires OATS **0.38.0 or later**, with `team-model-3` support;
these verbs also exist in the audited OATS 0.41.0 command contract. Check the
installed `oats version --json` and `oats help` through onboarding's inventory.
A source merge does not establish which package is installed. Provider acts
have their own version checks in the **composed `/oats-aweb` skill**.

Carry the intake authorization through routine reversible configuration and
readback. Shared changes follow the repository's review/merge policy. Do not
ask again for an unchanged decision. Stop only on a concrete failure or a
named missing input (for example, `missing shared-team policy authority`).

## Where teams are declared

```yaml
# oats-workspace.yaml (committed, shared: edited as /oats-workspace-config's "Change a shared file" says)
teams:
  engineering: { description: Platform and release automation, team: "engineering:acme.aweb.ai" }
  security:    { team: "security:acme.aweb.ai" }
  docs:        { team: "docs:acme.aweb.ai" }
  reviewers:   { description: Review rota }        # no id yet: team-unmapped
defaultTeam: engineering            # optional: the workspace's fallback default (a shared label)
localTeams: false                   # optional, default false: may deployments declare their own teams?
souls:                              # optional: per pattern, the default and the other teams a soul may join
  "*": { teams: [] }                                  # unlisted souls: default only
  security-souls/*: { default: security, teams: [engineering] }
  security-souls/incident-responder: { default: security, teams: [engineering, docs] }
  oats.engineering/*: { teams: any }                  # any = every shared team of this file
```

```yaml
# oats-local.yaml (this deployment only; only with localTeams: true)
teams:
  mine: { team: <team id>, description: My personal team }
defaultTeam: mine
```

- A **shared** team is the same provider team for everyone. Without `team` it
  is unmapped: `team-unmapped` (a warning; blocking when it is the default).
  Its owner uses the selected `/oats-aweb` procedure and commits the ID.
- **`souls:` keys are patterns:** `<member>/<soul>` or `<package>/<soul>`,
  `<member>/*` or `<package>/*`, and `"*"`. Member and package names are the
  ones `souls.disabled` uses (a member's name is its repository's name). A
  bare soul name is refused.
- Every label in `defaultTeam` and `souls:` must be a shared team of this
  file: an unknown label, or a `default` / `defaultTeam` that is not one, is
  `E_WORKSPACE_SCHEMA` when the file is read. A `souls:` key that is neither a
  pattern nor a discovered soul's qualified name is `team-soul-unknown` (a
  warning, in readiness and `oats teams --json` problems). So is a `<prefix>/*`
  pattern whose prefix matches no soul the workspace offers: a typo, or a
  member or package that was renamed or dropped. `"*"` never warns.
- **Local teams** are allowed only when the workspace says `localTeams: true`.
  A local team always has `team`. A label in both files is
  `team-label-collision` (a warning): the shared one wins; rename the local
  one.
- soul.yaml and oats-membership.yaml say nothing about teams. A soul or
  membership `team:`, `external[].team`, `messaging.byTeam` and
  `defaults.byTeam` are schema errors naming the replacement.

## Resolution

- **The most specific `souls:` key wins outright for `teams`** (lists never
  merge): the soul's own key, then `<member|package>/*`, then `"*"`. The
  default comes from the most specific key that sets one. So
  `a/*: {default: security}` and `a/x: {teams: [docs]}` give soul a/x default
  security and teams [docs] only.
- **A soul's default**, in order: its `souls:` default; else the
  deployment's `defaultTeam`, only when `localTeams: true`; else the
  workspace's `defaultTeam`; else none (`E_TEAM_UNCONFIGURED` when messaging
  is active). `OATS_DEFAULT_TEAM_FROM` (`defaultTeam.from`) says which:
  `soul`, `deployment` or `workspace`.
- **A soul's teams** (what it may join): its default, plus the `teams` of its
  matching `souls:` key, plus, with `localTeams: true`, every local team the
  deployment declares. A soul no key matches (and no `"*"`) gets its default
  only, member and package souls alike: a workspace opens a package
  explicitly.
- Each team row carries `from` (where the label is defined: `shared` or
  `local`) and `via` (why the soul may join it: an ordered subset of
  `default`, `workspace` from `souls:`, `local` for a local team under
  `localTeams: true`).
- A local `defaultTeam` that neither file declares is `E_TEAM_UNKNOWN`: a
  spawn, preview or `inspect --soul` is refused.
- Capabilities compose from the workspace defaults and the soul only; a team
  adds none.

## Act cards

Each card uses the version floor and selected context above. Readback is part
of the act; “Next” is the single handoff after its success predicate passes.

### Inspect declarations and a soul's eligibility

- **Prerequisites/context:** selected `D` and `S`; read-only access.
- **Commands:**
  ```bash
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
- **Effects:** none. Reports declared mappings, `localTeams`, deployment
  default, soul default, `match`, `defaultMatch`, and each team's `from`/`via`.
- **Success:** both reports resolve the selected deployment/soul, expected
  labels and canonical IDs are present, and no relevant failure remains.
  Eligibility is not membership.
- **Next:** select the configuration card matching the requested change, or
  the provider handoff below when configuration is already correct.
- **Error → remedy:** `E_TEAM_UNKNOWN` → fix the named missing label using
  the declaration card for its authorized shared/local scope, then reread.
  `E_WORKSPACE_SCHEMA` with `local-teams-closed` → use the refusal table.

### Declare or change shared mappings, default, or soul eligibility

- **Prerequisites/context:** shared-policy authority; selected workspace
  repository; selected labels/IDs and qualified soul patterns. Use the YAML
  shape above. All labels used by `defaultTeam` or `souls:` must be shared
  declarations in this file. `teams: any` means every shared team.
- **Edit/commands:** prepare one reviewed change to `oats-workspace.yaml`:
  put `T` in `teams.L.team`; set `defaultTeam: L` for the workspace fallback,
  or `souls.<qualified-pattern>.default: L` for a soul default; set that
  pattern's complete `teams` list for wider eligibility. Preserve unrelated
  keys. After the change is merged through the repository's normal policy:
  ```bash
  oats sync --dir D
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
- **Effects:** shared declarations and policy change; sync refreshes this
  deployment's workspace observation. No identities or memberships change.
- **Success:** readback shows the selected mapping, default and complete
  eligible set; `match`/`defaultMatch` identify the intended pattern and no
  relevant failure remains.
- **Next:** return to `/oats-onboarding`'s preview step for the selected seat.
- **Error → remedy:** `E_WORKSPACE_SCHEMA` for an unknown label → add the
  selected shared declaration or correct the reference in the same
  shared-file change.
  `team-soul-unknown` → correct the qualified key from `oats souls --dir D --json`.
  `team-unmapped` → use the provider handoff to obtain the authorized ID,
  then commit it in `teams.L.team`; do not guess one.

### Declare a local label

- **Prerequisites/context:** host-edit authority; selected `D`, `L`, `T`;
  workspace `localTeams: true` (or an intentional standalone deployment).
  The label must not already exist in either scope.
- **Commands:**
  ```bash
  oats teams add L --team T --dir D
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
- **Effects:** writes the local mapping. If no local default exists, also
  sets `defaultTeam: L`, even when a shared fallback exists. Every local
  team is eligible for every soul in this deployment. No provider call.
- **Success:** `L` resolves to `T` with `from: local`; the resulting default
  and eligible set match the selected policy.
- **Next:** use the provider handoff for the selected membership act.
- **Error → remedy:** `E_TEAM_EXISTS` → reuse the existing mapping if it
  matches; otherwise use the refusal table before redefining it.
  `E_WORKSPACE_SCHEMA` with `local-teams-closed` → shared-policy repair below.

### Choose the local default

- **Prerequisites/context:** host-edit authority; selected `D`, `L`, `S`;
  local teams allowed or intentional standalone; `L` already declared in
  either scope. A soul-specific shared default still wins.
- **Commands:**
  ```bash
  oats teams default L --dir D
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
- **Effects:** writes local `defaultTeam`. Does not migrate a running
  identity or change its primary team.
- **Success:** deployment default is `L`; soul readback shows
  `from: deployment`, unless an intended `souls:` default overrides it.
- **Next:** return to `/oats-onboarding`'s preview step for the selected seat.
- **Error → remedy:** `E_TEAM_UNKNOWN` → declare the selected label first.
  `E_WORKSPACE_SCHEMA` with `local-teams-closed` → choose the shared-default
  card or obtain a shared-policy change, rather than bypassing it locally.

### Remove a local label

- **Prerequisites/context:** host-edit authority; selected `D`, `L`;
  `L` exists locally and is not a purely local referenced default. This
  removal remains supported when local teams are closed.
- **Commands:**
  ```bash
  oats teams remove L --dir D
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
- **Effects:** removes the local declaration only. A shared declaration of
  the same label remains. It does not revoke an identity, leave a provider
  team, retire a seat, or clear local `defaultTeam`.
- **Success:** the local declaration is absent; retained mappings and
  defaults resolve correctly, with no relevant failure.
- **Next:** return to `/oats-onboarding`'s completion check.
- **Error → remedy:** `E_TEAM_IN_USE` → choose another authorized default
  first. With local teams closed, follow the migration row below instead.
  `E_TEAM_SHARED` → use the shared-removal card. `E_TEAM_UNKNOWN` → reread
  the selected deployment; an already-absent label needs no removal retry.

### Remove a shared label

- **Prerequisites/context:** shared-policy authority; selected workspace,
  `D`, `L`, affected souls and replacement policy.
- **Edit/commands:** in one reviewed workspace change, replace/remove every
  `defaultTeam`, `souls.*.default` and `souls.*.teams` reference to `L`, then
  remove `teams.L`. Repair any deployment-local default referencing `L`
  using the local-default card before removing its shared declaration.
  After the workspace change is merged:
  ```bash
  oats sync --dir D
  oats teams --dir D --json
  oats soul teams S --dir D --json
  ```
  Repeat soul readback for each affected selected soul.
- **Effects:** removes shared configuration and eligibility. No membership
  or certificate is revoked and running seats are not migrated.
- **Success:** shared `L` and its shared references are absent; selected
  deployment and soul defaults resolve to the replacement policy.
- **Next:** return to `/oats-onboarding`'s completion check.
- **Error → remedy:** `E_WORKSPACE_SCHEMA` for a remaining shared reference
  → fix it in the workspace change. `E_TEAM_UNKNOWN` for a local default
  → repair that deployment's reference under its authorized local policy.

## Refusals and configuration recovery

Codes below are emitted codes/conditions; dynamic labels and paths are not
fixed server text. After a repair, repeat the inspection card. Do not mint
an identity to work around a configuration refusal.

| Emitted code or condition | Supported remedy |
|---|---|
| `E_TEAM_NOT_ELIGIBLE` (provider) | Edit the complete matching shared `souls:` teams list under shared-policy authority (a shared-file change), sync once it is on the default branch, and reread eligibility. Local teams, if allowed, are eligible for all souls; there is no local per-soul override. Resume the provider act only after readback. |
| `E_TEAM_UNKNOWN` | Read the named reference and scope. Correct its label or declare the authorized mapping in the shared-file change or the local card; do not substitute an internal UUID for `T`. |
| `E_TEAM_UNCONFIGURED` | Choose an existing mapped default using the shared/local card. If no authorized provider team exists, hand off to `/oats-aweb`'s selected setup branch first; the diagnostic's bare setup hint is not a complete procedure. |
| `E_TEAM_SHARED` | Remove/change the declaration by a shared-file change (`/oats-workspace-config`, "Change a shared file"); `oats teams remove` cannot remove a shared declaration. |
| `E_TEAM_IN_USE` | `usedBy` identifies the local default. Set another declared default through the local-default card before removing a purely local label. If local teams are closed, use the migration row below. |
| `E_TEAM_EXISTS` | Read `from` and the mapping. Reuse a matching declaration. For a differing shared mapping, use a shared-file change. For an authorized local redefinition, first move a referencing default to another declared label, then remove/add; if no alternate exists, edit the selected local mapping in place and inspect it. Never silently change provider identity state. |
| `E_WORKSPACE_SCHEMA`, `local-teams-closed` | Either obtain the selected shared-policy change setting `localTeams: true`, then sync, or commit the selected team mappings/default in the workspace (a shared-file change), sync once it is on the default branch, and remove local `defaultTeam` from `D/oats-local.yaml` before `oats teams remove L --dir D` for each local declaration. Removing a label alone does not clear the local default. Reread after all local remnants are removed. |
| `team-label-collision` | Shared wins. If the local mapping is still needed, rename its local key and any local default reference to the selected noncolliding label in `D/oats-local.yaml`. If it is a migrated duplicate, remove the local copy and any disallowed local default. |
| `team-unmapped` | Ask the authorized provider procedure for the canonical ID and commit it in the shared mapping. Unmapped default is a failure; other unmapped labels are warnings. |
| `team-soul-unknown` | `oats souls --dir D --json` supplies qualified names. Correct/remove the shared `souls:` key by a shared-file change, then sync. |
| `default-team-changed` | Existing instance default remains recorded; return to onboarding for an authorized replacement seat. There is no generic in-place primary-team migration. |
| `E_WORKSPACE_SCHEMA`, `removed-key` for `souls.teams` / `souls.default` | Commit the error's replacement `souls:` entries with qualified keys, preserving each soul's full eligible list (a shared-file change); sync once it is on the default branch, then remove the old local keys. Use `localTeams: true` only if selected policy permits local teams. |
| `E_LOCAL_CHANGED` | Reread the local file after the competing writer settles, then retry the same authorized edit. |

Older `messaging.byTeam`, `defaults.byTeam`, soul/membership `team:`, and
`external[].team` are schema errors. Move mappings into shared `teams` and
policy into workspace `souls:`; do not add team settings to soul manifests.

## Provider and lifecycle handoff (no duplicate recipes)

Load the **composed `/oats-aweb` skill** for first hosted LOCAL account setup,
controller-owned team creation, labelled LOCAL root join/resume, invitations,
GLOBAL resident bootstrap/reuse, grant lifecycle, wider-team join/leave, and
receive proof. Select the exact procedure heading in `/oats-onboarding` card 5 using the
existing intake inputs; its heading contract distinguishes current sections
from provider integration targets.
If that procedure is missing or its installed version cannot support the
selected act, report that exact prerequisite to the oats.aweb owner; do not
infer installation from a source merge or construct an alternative command.

- At spawn, the default is joined; wider eligible teams are joined only on
  request through the provider. For a later join/leave, use the target's own
  instance home, never the caller's accidental scope. Provider join state is
  separate from these config reports.
- A joined team is woken only by the host wake broker. The first joined team
  on a host that recorded “broker not needed” reopens that choice
  (`/oats-host-delivery`, Choice 2).
- Token-only provider join remains blocked until supported by the installed
  release ([oats-aweb#56](https://github.com/awebai/oats-aweb/issues/56)); use
  the provider's labelled join/resume procedure. Never redeem another token
  merely to retry an uncertain connection.
- Bare provider hosted additional-team creation remains refused by the
  audited provider. Its `aweb-abkh` unreleased wording is stale: native hosted
  sibling creation is published in aw 1.36.24, absent in audited 1.36.23.
  Use `/oats-aweb` §8 “Hosted team creation” card under its specified owner/admin
  authority; private invite output does not auto-join the caller. No implicit
  install or trial. Controller-owned namespaces are a separate authorized
  branch, never a workaround for absent hosted authority.
- GLOBAL grant-seat wider-team join/leave is blocked on
  [oats-aweb#60](https://github.com/awebai/oats-aweb/issues/60).
  `E_TEAM_GLOBAL_MODE` → report the owner-side contract blocker; no LOCAL
  fallback, native identity switch, or duplicate custody.
- `E_TEAM_DEFAULT: <label> is the default team and cannot be left` → stop
  that leave; changing config does not move the running identity.
- Cloud dashboard human-account/role invitations: **aweb Cloud owner**,
  human-account procedure established in deployed Cloud 0.8.28 source
  `7665d863` (deployment confirmed by the aweb maintainer). Organization owner/admin authority is required. Agent token
  invites and organization-level membership invitations are distinct acts.
- Seat retirement belongs to `/oats-operate`; provider membership/certificate
  removal belongs to `/oats-aweb`. Label removal is neither operation.
- Receive proof belongs to `/oats-aweb`: Codex always uses the host broker,
  with no native channel. Claude/Pi primary native delivery and joined-team
  broker delivery are distinct paths; native enrollment must be confirmed
  by the installed provider procedure.
