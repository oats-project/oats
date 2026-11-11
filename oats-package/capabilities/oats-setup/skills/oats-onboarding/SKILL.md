---
name: oats-onboarding
description: >-
  Use when helping an operator realize an OATS workspace on a machine: deciding
  where the workspace file is hosted, writing or checking the shared
  declarations, choosing the deployment directory, running `oats onboard`,
  placing host settings, syncing, messaging and host delivery, cloning work
  targets and verifying before the first spawn. Also use it to set up okf
  knowledge operations (the knowledge maintainer, the proposal review
  trigger, a soul's opt-out). For package pins see
  `/oats-package-pins`. Part of the setup and config of an OATS workspace
  (oats.setup); day-to-day operation inside an instance is oats.core.
---

# Onboarding a deployment

This is the procedure for intake, ordering, operator composition and completion.
A setup expert spawned by `oats-getting-started` starts at `/oats-setup-expert`.
Optional rationale, not a prerequisite: the project's operator knowledge node.
Contracts: `docs/workspaces.md` and `docs/configuration.md` under `oats root`.
Team declarations belong to `/oats-teams`; provider identity, admission,
custody and delivery procedures belong to the composed `/oats-aweb` skill.

## 1. One intake, then execute

Use inputs already supplied by the task; collect the remaining inputs together:

- Authorized deployment directory and workspace repository; new or reuse,
  existing clones/private repositories, pins and target first task with its
  success criterion.
- Account/team authority and canonical provider team ID (`name:namespace`,
  not an internal UUID); authorized account creation or existing admission;
  LOCAL minting root or fresh/reused GLOBAL resident; owner custody reference.
- Team label/default/eligibility policy, selected root and instance names,
  soul, harness/model/launch configuration and required capabilities.
- For GLOBAL: resident, grant profile, TTL and renewal policy. For all seats:
  primary and joined receive requirements, including whether native delivery
  is mandatory, and authorized effects (files, identities, sessions, services; host delivery: card 4).
- Knowledge binding, if selected, and credentials supplied through the
  provider's private input channel. Never ask for secrets in conversation.

Carry that authorization through routine reversible setup, sync, preview,
scaffold, launch and verification within the selected scope. Do not ask again
per file, command, unchanged preview or receipt. Stop only for a concrete
missing input/authority, a failed predicate or an unsupported path; name the
blocker, its owner and the single input or remedy needed. A changed preview
within the same authorized scope needs readback, not another approval round.

In the cards, replace `D` with the selected absolute deployment, `S` with the
qualified target soul, `H` with the returned instance home, `N` with the
selected instance name, `F` with its task-file path and `R` with the preview's
`decision.revision`. `HARNESS` is the selected `claude`, `pi` or `codex`.
Run deployment commands from the operator's instance home with `--dir D`;
instance commands explicitly select `H`. Do not copy these symbolic values.

Preserve workspace-approved soul launch/harness constraints. `HARNESS` must
agree with that policy; the example is not permission to override it. If the
resolved launch already selects the authorized harness, omit `--harness` from
both preview and apply. A missing owner opt-in or prompt confirmation is a
prerequisite blocker, never a prompt to answer silently.

**Version boundary:** these kernel command forms are checked against OATS
0.41.0; team configuration requires 0.38.0 or later. Provider procedures must
state their own released version support. A source merge, guide on main or
package pin is not proof that a running home contains the change. Use
`oats version --json` and the installed provider's version/help and recorded
module provenance; if the composed procedure lacks the selected supported act,
report that provider-version blocker to its owner. Do not reconstruct it from
source or knowledge-base notes during execution. In aw 1.36.23 and 1.36.24,
external `--identity-home` is not supported for `team invite`,
`id team remove-member` or `doctor local`; global help alone does not
establish that allowlist. `id team accept-invite` is supported, and
`id team create` is also supported from 1.36.24. External-home invite issuance,
certificate removal and required local-category diagnostics stay blocked
pending a native owner-supported context; identity/registry diagnostics do
not replace missing local-category evidence. Never clear identity selection
to bypass a refusal. See the [corrected compatibility cards](https://github.com/awebai/oats/issues/709#issuecomment-6030635650).

## 2. Inventory and select reuse or new

**Prerequisites/context:** intake complete; selected `D` (OATS 0.41.0); this card makes the first Git reads, which need Git access to the workspace's repositories (GitHub over https, as `oats-getting-started` sets it up, is enough). `/oats-git-setup` is optional: run it when these reads fail on access, or when the person wants an SSH key, signing or the DCO sign-off.
**Commands (read-only):**

```bash
oats workspace status --dir D --json
oats souls --dir D --json
oats teams --dir D --json
oats soul teams S --dir D --json
```

For current identity/team inventory, use `/oats-aweb` “Who you are” and
“Find who to talk to” in that identity's own home. A roster does not establish
account authority or identify the coordinator.

**Success:** the workspace status envelope's `result.workspace.local` is
exactly `D/oats-local.yaml`. Only then enumerate confirmed members, locked
packages, available souls, team mappings/defaults and reusable host state
against the intake.
**Next:** use card 3 for a new deployment, otherwise card 4.
**Error → remedy:** a different `result.workspace.local` path → `D` is inside
another deployment. For a new deployment use card 3; for reuse, stop and name
the deployment-path blocker to its owner. Never sync or edit the resolved
ancestor. `E_LOCAL_MISSING` → if `D` is the authorized new directory,
use card 3; if reuse was selected, resolve the incorrect/missing deployment
with its owner before writing. `no-backlink`, `backlink-elsewhere`,
`not-listed`, `cannot-read` → correct the shared membership declaration or
owner's Git environment (`/oats-git-setup` and its check), then repeat this inventory. From OATS 0.56.0, a
failed or unparseable Git version probe preserves the remote cache and its
pins: fix the local Git failure and retry without deleting the cache. Never
invent another repo.

## 3. Establish the selected workspace

**Prerequisites/context:** new deployment authorized; selected repository
reference `W`; reviewed shared declarations available; OATS 0.41.0.
If any member is private, host the workspace in a private repository that is
not itself a public member. Inspect package manifests' commands/hooks before
using the intake's trust authorization. Shared workspace, membership and soul
changes follow the project's Git review path. Do not merge them without that
authority.

Shared `teams.<label>.team` IDs and schema-defined trigger `runsOn`/`owner`
identifiers belong in Git. Absolute host paths, credentials, custody and
resident directories stay host-private. Use `/oats-workspace-config` for
shared file shapes and `/oats-package-pins` for selected pins.

**Command:**

```bash
oats onboard D --workspace W
```

**Effects:** local configuration, lock and `agents/` scaffold in `D`; no seat
is spawned. **Success:** reported members are confirmed and packages locked.
**Next:** card 4.
**Error → remedy:** `E_REPO_REF` → correct `W` to the owner-selected repository
reference; `cannot-read` → owner fixes the reported Git access or local Git
version-probe failure, then inventory `D` before
retrying. Do not overwrite partial or existing state to force onboarding.

## 4. Prepare host settings and sync

**Prerequisites/context:** selected deployment and authorized host settings;
merged shared changes, if any; OATS 0.41.0. Before any host edit or sync, run
`oats workspace status --dir D --json` and require `result.workspace.local`
to equal `D/oats-local.yaml`; a different path uses card 2's deployment-path
remedy, without editing or syncing the ancestor.
Use the installed provider's settings contract for knowledge bindings/state
paths, messaging roots or resident custody. Bind the project's own knowledge
aliases; never substitute a central base owner or copy a running home.
Use `/oats-workspace-config` for the selected host launch configuration. Clone selected work targets with
the owner's Git credentials only for `worktree`/`checkout` souls: the kernel
uses `--repo`, then the local `clones` map, then `D/<repo name>`.
**Required:** make and record both host delivery choices (`/oats-host-delivery`): write `claudeChannelMode`
now; the operator installs the broker once aw meets its floor (card 5 can install aw), before card 6. A
macOS host driven over `--server` or running Git in background jobs needs Git without a terminal (`docs/servers.md`, “Git on a macOS host”).

**Commands (after the authorized edits):**

```bash
oats sync --dir D
oats workspace status --dir D --json
```

**Effects:** resolves packages and writes the lock; refreshes shared state.
**Success:** status still reports `result.workspace.local` exactly
`D/oats-local.yaml`; confirmed members, correct locked pins, required host
bindings and clones are present; both host delivery choices recorded. **Next:** card 5.
**Error → remedy:** `E_PATH symlink not allowed` from a provider → select a
real absolute host path within the authorized scope (on macOS `/private/tmp`
rather than `/tmp`); preserve the failing output and rerun the provider check.
An integrity refusal is a pin/owner problem, never a reason to hand-edit the lock.

## 5. Select the canonical messaging act

**Prerequisites/context:** intake authority/scope selected; provider's released
version and its composed procedure support the act. No provider command is
redefined here. Execute the selected card in `/oats-aweb`, then use
`/oats-teams` to read back mapping/default/eligibility before card 6.

**Provider version boundary:** the referenced canonical `/oats-aweb` cards
were published in oats.aweb **1.22.1**
([oats-aweb#64](https://github.com/awebai/oats-aweb/pull/64)). Use a card only when the actually
installed provider's skill contains it and supports the selected act. For
earlier installed providers, including 1.21.1 and 1.22.0, follow their own
installed skill text. A missing card is an oats.aweb owner boundary: report
the missing procedure, never invent a command. A source merge or package pin
does not prove that a running home has composed the released cards.

Provider heading contract: §8 “8. Provider configuration and setup internals”
owns setup; §5 “5. Teams: join and leave” owns existing LOCAL seats; §7
“7. Troubleshooting” is the error index. The named §8 subheadings and §4
“Receive verification and recovery” below require the released cards to be
composed. On earlier providers, use their §8 or §4 “4. How messages reach you
(delivery and wakes)” only when it already contains a complete,
version-supported procedure for the selected act; otherwise report the
missing provider procedure.

| Selected act | Canonical procedure / boundary |
|---|---|
| First hosted account/team with LOCAL root | `/oats-aweb` §8: first account, selected username/authority |
| Additional team under an owned namespace | `/oats-aweb` §8: BYOT/controller create; use only the selected domain authority |
| Existing LOCAL deployment root admission | `/oats-aweb` §8 “LOCAL team join and resume”: labelled join with private token input, selected service and root alias |
| Interrupted LOCAL root join | `/oats-aweb` §8 “LOCAL team join and resume”: accepted-state resume without another token; read back uncertain effects first |
| LOCAL or existing GLOBAL member invitation | `/oats-aweb` §8 “Invitations and certificate ownership”: external-home invite issuance is blocked pending supported owner context; `id team accept-invite` remains supported. Distinguish admission from spawn authority |
| Fresh/reused GLOBAL resident and grant seat | oats.aweb 1.26.0+ (aw >=1.36.33): the dashboard's line in D, `AWEB_API_KEY=<key> AWEB_URL=<url> oats aweb resident create <name> [--team-label <label>]`, creates or adopts the resident, installs its per-user custody unit and records `residents.<name>`; `--plan` first changes nothing. `/oats-aweb` §8 “GLOBAL residents and grant seats” and its `references/existing-team-global-resident.md` (“A GLOBAL resident in an existing hosted team”) carry the card; plain-aw users keep the dashboard's plain command and start custody themselves. Then the selected grant settings for card 7 |
| LOCAL wider-team join/leave | `/oats-aweb` §5 “5. Teams: join and leave”; run in target home, eligibility from `/oats-teams` |
| Remove a label | `/oats-teams`, configuration removal; it does not revoke an identity |
| Retire an OATS seat | `/oats-operate`, retirement plan/apply under intake authority; provider owns grant/membership outcome |
| Owner certificate removal or resident cleanup | `/oats-aweb` §8 “Invitations and certificate ownership”; external-home certificate removal is blocked pending supported owner context. Hosted archival with active certificates and generic GLOBAL cleanup remain owner-path pending; customer-specific cleanup is not a generic recipe |
| Delivery and checkpointed restart/recovery | `/oats-aweb` §4 “Receive verification and recovery”; `/oats-operate` owns session lifecycle |

Provider/native support boundaries (retain the named owner on a blocker):

- Token-only deployment join: aweb provider owner,
  [oats-aweb#56](https://github.com/awebai/oats-aweb/issues/56); do not drop the label.
- Bare provider hosted additional-team creation: the audited provider still
  refuses this route; its `aweb-abkh` “not yet released” message is stale
  provider wording, not current product status. Native hosted sibling-team
  creation is published in aw 1.36.24 (absent in audited 1.36.23); use the
  composed `/oats-aweb` §8 “Hosted team creation” card with selected source team,
  owner/admin authority and request ID. Its secret invite output stays private
  and the caller is not auto-joined. Do not install or trial it implicitly.
- GLOBAL grant-seat wider-team join/leave: aweb provider owner,
  [oats-aweb#60](https://github.com/awebai/oats-aweb/issues/60); no in-seat LOCAL switch.
- Cloud dashboard human-account/role invitation: route to the aweb/Cloud
  owner's human-account procedure, established in deployed Cloud 0.8.28
  source `7665d863` (deployment confirmed by the aweb maintainer). It requires organization owner/admin
  authority and selected team, email and role; an agent token invite and an
  organization membership invitation are different acts.

Claude/Pi primary delivery uses its configured native channel/extension when
selected. Claude's aweb channel needs card 4's Choice 1 (`/oats-host-delivery`)
made and, on the approved route, its banner check passed; do not assume
admission. Codex has **no native channel**: its automatic receive path is the
host broker everywhere. Joined `receive: native` denotes the joined-identity
**broker** (card 4's Choice 2), not a Claude/Pi native channel; `receive: poll`
is manual. If mandatory native enrollment is unavailable or unconfirmed, report
that blocker rather than silently using a broker and claiming native success.

## 6. Check operator composition and preview

**Prerequisites/context:** host/provider readiness and team configuration
resolved; selected project operator plus target `S`; OATS 0.41.0.
For the operator, use its qualified soul as `S` and its selected `N`/`F`.

```bash
oats readiness --soul S --dir D --json
oats spawn S --dir D --name N --harness HARNESS --task-file F --preview --json
```

Include the intake's selected model/launch and provider options in the preview
and carry those exact options into card 7. GLOBAL options come from the
provider's resident/grant card (`--provider oats.aweb identity.mode=global
--provider oats.aweb identity.resident=<name>`, as `oats aweb resident create`
prints them), not a guessed `setup --global` flag.

**Effects:** read-only checks and preview. **Success:** enumerate resolved
modules, merged host settings, selected launch, mapped default and eligible
teams. The operator must resolve `oats.setup` (including these onboarding and
teams skills), the selected core/messaging capabilities and its own knowledge
binding if selected. Check composition, not the literal name
`oats-operator-expert`. For each team in scope record eligible operator
coverage separately from an actually authorized/running operator seat.

A project operator need not import this repository's central operator soul,
its engineering/cloning roles, private workspace capability or knowledge
identity. Declare project-owned composition through existing configuration;
there is no new inheritance mechanism. An absent usable operator is a named
setup blocker to its owner; `operator-soul-missing` / `operator-team-uncovered`
are proposals in [#671](https://github.com/awebai/oats/issues/671), not existing
kernel warnings. **Next:** card 7 with the returned decision revision.
**Error → remedy:** `E_TEAM_UNCONFIGURED` or configuration refusals →
`/oats-teams` error table; unavailable provider/knowledge prerequisites → the
owning provider's card. Do not launch past a failed required check.

## 7. Scaffold, inspect, then start

**Prerequisites/context:** successful card 6; same authorized inputs and
`R = decision.revision`; OATS 0.41.0. Lifecycle owner: `/oats-operate`.

```bash
oats spawn S --dir D --name N --harness HARNESS --task-file F --no-launch --expect-decision R --json
```

**Effects:** creates the home/work and runs provider hooks, without launching.
**Success:** exit success and returned `H` exists; exactly one “You run on OATS”
briefing, expected composed skills, `Comms:` delivery route and recorded
`defaultTeam.team` matching the selected team. The scaffold's recorded
`instance.json` modules name the selected package versions/commits. A failed
scaffold must never be followed by session start.
**Next:** card 8.
**Error → remedy:** `E_DECISION_STALE` → repeat card 6 and inspect the change;
`E_REQUIRED_HOOK_FAILED` → retain private stdout/stderr/exit, inspect rollback
and provider state, then use that provider's remedy. Do not retry uncertain
identity effects blindly or edit receipts to make validation pass.

## 8. Start and prove the first task

**Prerequisites/context:** successful inspected scaffold `H`; launch authorized;
OATS 0.41.0; provider's selected receive route ready.

```bash
oats session start --home H --json
oats readiness --home H --json
```

**Effects:** starts the scaffolded session and checks prerequisites.
**Success:** the provider's delivery card proves a nonce message actually
presented automatically and a receiver-verified reply for the exact message
ID; the first task is done and its result consumed; each recorded choice's check in
`/oats-host-delivery` passes, and the hand-back records both. Readiness, a send receipt
or unread inbox status alone is insufficient. Record tested versions, source
and composed provenance, route, exact message IDs, safe receipts, timings and
any explicit holds. A future authorized timed acceptance measures pasted
command to receiver-verified reply (target ≤30 seconds), without subtracting
holds; report preparation, selection and recovery separately. Preserve an
initial pushed `verification_stale` event separately from a later verified
exact-message read; the latter does not rewrite the initial observation. This card does
not authorize a disposable acceptance rehearsal. Keep private failure bodies local; report safe code and
owner. **Next:** hand back that completion evidence to the task owner.
**Error → remedy:** `E_SESSION_UNKNOWN` → verify the scaffold result and `H`
before retrying; `grant_expired`, `grant_revoked`, `grant_subject_inactive`,
`grant_issuer_revoked` or `grant_freshness_unavailable` → stop worker messaging
and send the code to the custody owner for the supported grant lifecycle.
For interrupted delivery use the provider's exact-message-ID recovery;
checkpointed restart is a separate authorized lifecycle act, not automatic
receipt repair.

## Knowledge operations with OKF

Set this up only after cards 1–8 succeed, and only when the intake authorizes proposed
knowledge reviewed and merged by an agent. It needs kernel ≥ 0.69.2 (the first that
reads the `background:` key oats.okf's package souls declare) and `oats.okf` 6.0.1. The contract is
`docs/knowledge.md` ("Knowledge operations") and `docs/schedules.md`
("Triggers", "Workspace triggers and schedules") in the installed kernel, and
okf's own README at the pinned tag; read them, and okf's own
`/okf-trigger-setup`, rather than restating either from memory.

### 1. Pin the package

`packages: { oats.okf: v6.0.1 }` in the workspace file, then `oats sync`
(`/oats-package-pins`). One pin brings, versioned and locked together:

- the capabilities: `oats.okf` (every working soul's knowledge slot) and
  `oats.okf-maintenance` (the maintainer's);
- the **package soul** `oats.okf/knowledge-maintainer` (`oats souls` lists it
  as `kind: package`);
- the **review-trigger template** `oats.okf:proposal-review`.

Until 7.0 it also carries the stubs of the removed harvester
(`oats.okf-harvest`, `oats.okf/knowledge-harvester`): they refuse every spawn.

Show the operator what the package runs before pinning (its manifests'
`commands` and `hooks`): declaring it is the trust decision, for its souls too.

### 2. The maintainer lives in the default team

Since oats.okf 4.0.2 okf declares and joins no team of its own: the
maintainer lives in the deployment's default team, where they talk
(questions, amendment requests, "merged"). There is nothing to declare. To put
it in another team, opt them in like any soul, by a `souls:` entry in
`oats-workspace.yaml` (`oats.okf/*: { teams: [<label>] }`), then join at
spawn (`/oats-teams`).

### 3. Declare the review trigger for ONE host that can merge

The trigger spawns a `knowledge-maintainer` for each knowledge proposal PR
(label `okf-proposal`) on the knowledge-base repo. Declare it as a **workspace file** in a member repo (the
workspace's host repo is the usual place): it is shared through Git, reviewed
like a soul, and names **the machine that runs it** and **the GitHub account
it acts as**.

```yaml
# <member repo>/oats-triggers/okf-proposal-review.yaml
kind: oats-trigger
schemaVersion: 1
description: Review every knowledge proposal PR on the knowledge base
from: oats.okf:proposal-review
set: { repo: github.com/<org>/<knowledge-base> }
runsOn: <host name>                 # that machine's oats-local.yaml host.name
owner: github.com/<account>         # the account it acts as; it must be able to MERGE on the knowledge base
```

- **Choose the machine and the account together.** A host runs the trigger
  only when `runsOn` is its `host: { name: <slug> }` in `oats-local.yaml` (a
  machine fact, never in Git) **and** its `gh` is logged in as `owner`.
  Anywhere else it is listed with why not (`assigned-elsewhere`,
  `owner-mismatch`, `host-unnamed`). So "exactly one host" is a declared fact,
  and the operator's consent is naming the host and logging in as the account.
- **Handle the self-approval limit.** GitHub forbids approving your own PR. If
  `owner` is also a proposing host's account, either use a separate reviewer
  or bot account as `owner`, or let the knowledge-base repo's accepted branch
  need no approving review (merge permission only).
- The file's contract (required fields, where it may live, its refusals) is
  `/oats-automations`, "Workspace automations".
- **Protect the accepted branch** (PRs only, merged by the maintainer's
  account) and give each proposing host's account branch-create access on the
  knowledge-base repo, never accepted-branch push (`/okf-trigger-setup`).
- `oats trigger add --from oats.okf:proposal-review --set repo=… --workspace <member> --runs-on <host name> --owner github.com/<account>`
  writes the file, or prints it when that repo is not the current checkout.
  Commit it as a reviewed change, then `oats sync`.

Then, **on the named host**, from its deployment directory:

```bash
oats trigger test <member>/okf-proposal-review  # must pass: runs here, owner = this gh login, merge permission, the soul resolvable
oats schedule host status                       # has this host the ONE host timer yet? (docs/schedules.md)
```

**If this host has none yet, installing the timer is the operator's step, in
their own shell, never yours:** `install` renders the unit from the
environment of the shell it runs in, and an agent's shell can carry a
session's own `PATH` and node. Hand the operator the exact command to run in
their own terminal, from the deployment directory and outside every instance
home:

```bash
oats schedule host install
```

After the operator has run it, check the result yourself with
`oats schedule host status`. With no operator at the machine, the timer stays
as it is until they run the command: do not run it in their place. The step in
full (the cap flags, why its `--print` is no preview) is `/oats-automations`,
"One host timer, no daemon".

**The machine-private alternative** is a local trigger: this host only, its
own `gh`, no `runsOn`/`owner`, id `local/okf-proposal-review`. Use it to try
the loop out; anything a team relies on belongs in the workspace file.

```bash
oats trigger add --from oats.okf:proposal-review --set repo=github.com/<org>/<knowledge-base>
```

### 4. Proposals in okf 6, and the soul's opt-out

oats.okf 6.0 has no harvester, and no host or spawn switch for the duty to propose.

- **How it works:** a working soul whose knowledge slot is `oats.okf` reads
  the compulsory `okf-propose` skill from its IMPORTANT inject and checks
  `oats okf status`. At each knowledge checkpoint the skill names, it proposes
  its new durable claims itself with `oats okf propose` (`--plan`, `--check`,
  `--apply`): one PR labelled `okf-proposal`, for the review trigger
  (section 3). Nothing is spawned; nobody waits for the PR. Only new spawns
  get the duty after the pin.
- **The one switch is the soul's own opt-out:** `knowledge: { harvest: off }`
  in its `soul.yaml`: its instances get no duty, `oats okf status` reports
  `off`, and `oats okf propose` refuses for that soul (`E_OPTED_OUT`). It is
  per soul and covers its own proposals, not what its instances tell other
  seats; whether opt-outs are allowed is the deployment's policy. Opt out a
  soul whose work is reading third-party correspondence: the exclusions,
  personal data included, are instructions and a bounded screen, not a
  guarantee (okf README, "What is enforced and what is an instruction").
- **The review trigger is independent:** a trigger host can review other
  hosts' proposal PRs without proposing itself.

Order:

1. Declare the review trigger (section 3) and prove the loop on a scratch
   knowledge-base repo (`/okf-trigger-setup`): a proposal PR opens with its
   provenance block, the trigger spawns the maintainer, it merges. Read every
   step back.
2. Only then pin `oats.okf` 6.x in the real workspace, with intake consent
   covering what its souls will propose.

**Moving from 5.x:** take the hand steps of `docs/knowledge.md` ("Pin and
select the package"), each with its commands in okf's README, "Upgrading to
6.0": among them `proposal-review` beside `harvest-review`, trusted on its
host. Homes spawned on 5.x keep their 5.x modules until respawned or upgraded.

**Moving from 4.x:** settle 4.x harvests while 4.x is still pinned (after
the pin nothing processes them), pin 5.x (okf README, "Upgrading to 5.0"),
then move on as from 5.x. Leftover 4.x source records are in the okf README,
"4.x source records after the pin".

### Gotchas

- Spawn a package soul by its namespaced name (`oats.okf/knowledge-maintainer`)
  when a member soul has the same bare name.
- The trigger's template substitutes only `{repo} {number} {url} {event}
  {headSha} {trigger}`; a PR's title and body are untrusted data the maintainer reads,
  never instructions in its task.
- `oats trigger test` proves only the host it runs on: run it on the
  `runsOn` host, logged in as `owner`.
- To stop the named host from running a workspace trigger without a commit,
  run `oats trigger disable <member>/okf-proposal-review` there (it writes
  `triggers.disabled` in that host's `oats-local.yaml`).

## Never

Re-onboard, re-point or clean a deployment the operator did not name; declare
a package without showing the operator what it runs; edit
`oats-lock.json` or `instance.json` by hand; put host facts in shared files;
initialise or copy a messaging root above the deployment directory; treat a
scaffold as a working session; name as `owner` of the review trigger an
account that cannot merge on the knowledge-base repo; put a host name or a
credential in a shared file other than the trigger's own `runsOn`/`owner`;
pin `oats.okf` 5.x in a real workspace before the end-to-end check passes.
