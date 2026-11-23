# Integrations: binding an implementation to a contract

An **integration** is a capability that fills one exclusive slot:
`knowledge`, `messaging` (the communication contract) or `tasks`. The
contracts themselves are in [the OATS contracts](layers.md); this page is
about choosing an implementation and building one. For manifests, hooks,
commands and settings in general, read [capability packages](capabilities.md)
first.

## The slots

For each soul, OATS resolves zero or one implementation per slot:

| Slot | Contract | Official providers |
| --- | --- | --- |
| `knowledge` | [knowledge](layers.md#the-knowledge-contract) | `oats.okf` |
| `messaging` | [communication](layers.md#the-communication-contract) | `oats.aweb` |
| `tasks` | [tasks](layers.md#the-tasks-contract) | `oats.aweb-tasks`, `oats.jira`, `oats.linear` |

A capability becomes an integration by declaring exactly one `layer` in its
manifest. Capabilities without `layer` compose additively.

Exclusivity is the point. Task state belongs to the selected tasks
implementation even when a messaging tool also offers task features, and
conversation belongs to the messaging implementation even when a tracker
offers comments.

## Selecting an integration

A soul gets a capability from its own `capabilities:` and slot choices plus
the workspace `defaults`. Member capabilities are trusted by membership;
package capabilities by the workspace's `packages:` declaration, which pins
each by version and is locked by `oats sync` ([workspaces.md](workspaces.md#membership-and-trust),
[packages.md](packages.md)).

The manifest already declares the slot, so a `capabilities:` entry does not
repeat it: a capability with `layer: tasks` fills the tasks slot wherever it
arrives from.

```yaml
# oats-workspace.yaml: one default per slot, for every soul
packages:
  oats.okf: v6.3.0
  oats.aweb: v1.48.0
  oats.linear: v1.0.1
  oats.jira: v1.0.1
defaults:
  knowledge: { oats.okf: { from: package } }
  messaging: { oats.aweb: { from: package } }
  tasks: { oats.linear: { from: package } }

# souls/planner/soul.yaml: keep the defaults, supply a slot payload
tasks:
  team: ENG
  project: Agent Platform

# souls/support-triager/soul.yaml: opt out of one slot, replace another
knowledge: none                            # empties the slot
capabilities:
  oats.linear: off                         # removes the tasks default...
  oats.jira: { from: package }             # ...so this one fills the slot (two would be E_SLOT_CONFLICT)
```

- A soul's slot key is either `none` or that slot's payload (settings for the
  provider that fills it).
- Two layered capabilities for one slot (a default plus a soul entry, or two
  soul entries) is `E_SLOT_CONFLICT`; spell `<cap>: off` to remove the one you
  do not want.
- `none` is a slot selection, not a policy: a soul with `messaging: none` has
  no address.
- Host facts (absolute paths, custody directories) go in the deployment's
  `oats-local.yaml` under `settings.<capability>`. The full merge order of
  provider settings is in [capabilities.md](capabilities.md#who-gets-a-capability).

## Official providers

Each provider's own repository documents its settings, commands and
operations in full.

| Slot | Provider | Needs on the host | Documentation |
| --- | --- | --- | --- |
| `knowledge` | `oats.okf` | `settings.oats.okf.bindings-file` and `state-dir` (absolute paths) in `oats-local.yaml`; `git` for Git-backed consultation, `git` and `gh` for proposal/review PRs; ordinary kernel/harness selection, no provider harvest-runtime setting | [awebai/oats-okf](https://github.com/awebai/oats-okf), [knowledge.md](knowledge.md) |
| `messaging` | `oats.aweb` | the `aw` CLI at 1.36.33 or later; for channel delivery, `@awebai/pi` in pi or the `aweb-channel` plugin in Claude Code; host-only `root`, `roots` and `residents` in `oats-local.yaml` | [awebai/oats-aweb](https://github.com/awebai/oats-aweb) |
| `tasks` | `oats.aweb-tasks` | the `aw` CLI at 1.36.33 or later, and `oats.aweb` as the soul's messaging: tasks act as the instance's own oats.aweb identity in its default team; nothing in `oats-local.yaml` | [awebai/oats-aweb](https://github.com/awebai/oats-aweb) |
| `tasks` | `oats.jira` | `acli`, authenticated to the Jira site; `site` and `project` in the soul's `tasks:` payload or `settings.oats.jira` | [awebai/oats-jira](https://github.com/awebai/oats-jira) |
| `tasks` | `oats.linear` | `LINEAR_API_KEY` in the environment (never in OATS config); `team` (and optionally `project`) in the soul's `tasks:` payload or `settings.oats.linear` | [awebai/oats-linear](https://github.com/awebai/oats-linear) |

- **`oats.okf`** consults the soul's external OKF bases, keeps instance
  knowledge, and teaches the duty to propose in its IMPORTANT inject block and
  compulsory `okf-propose` skill, not the task briefing. Eligible instances
  propose durable claims at their knowledge checkpoints (a finished task, a PR
  handed over) themselves, with `oats okf propose`, as one pull request each;
  no worker is spawned. The soul-only `knowledge: { harvest: off }` gives no
  duty to propose while retaining consultation. No host switch or automatic
  transcript/retire capture remains; `knowledge-maintainer` reviews the
  resulting Git PRs.
- **`oats.aweb-tasks`** (in the `oats.aweb` package from 1.31.0) fills the
  tasks slot with aweb tasks, acting as the instance's own `oats.aweb`
  identity in its default team. **An existing workspace opts in** by pinning
  `oats.aweb: v1.48.0` (the feature needs 1.31.0 or later), adding
  `tasks: { oats.aweb-tasks: { from: package } }` to `defaults`, and running
  `oats sync`. Only new spawns get it. A soul that names its own tasks
  provider in `capabilities:` (`oats.jira`, `oats.linear`) then holds two and
  fails with `E_SLOT_CONFLICT`: to keep its own, it adds
  `oats.aweb-tasks: off` to its `capabilities:`. A soul opts out of tasks
  entirely with `tasks: none`. **A new workspace** made by the `oats-getting-started`
  skill with aweb (not on a machine found-list) has it by default: the
  skill writes this default (the team's first aweb task opts it in), unless
  the person's projects
  already use a tracker (GitHub issues in use, Jira, Linear and the like),
  when it writes `tasks: none`. The setup expert then offers to make a tasks
  capability of the workspace's own for that tracker, from how the team uses
  it, and makes it the tasks default on the person's yes; it pins no
  generic provider in its place.
- **`oats.aweb`** mints a messaging identity for each instance at spawn and
  removes it at retire, contributes the aweb messaging skills, and wires the
  channel so sessions are woken by mail. Under `delivery: channel`, Claude Code
  loads the channel plugin with `--dangerously-load-development-channels`,
  and the kernel confirms the development-channel prompt once at launch.
  The start reports that decision (`channel-dev-confirmation`); readiness
  becomes quiet after the kernel records a completed confirmation. If Claude
  ignored the flag, readiness reports `claude-channels-unavailable`.
  `settings.oats.aweb.claudeChannelMode: approved` stops the prompt. That
  setting and the host's wake broker are the operator's choices in
  oats.setup's `/oats-host-delivery`. `oats aweb roster` lists the team:
  its membership certificates and workspaces, one entry per alias with its
  sources, status and kind (global identities first), and says when either
  source is incomplete. After `oats server connect`, `oats aweb connect
  <server-id>` gives the server's deployment membership in its default team
  through the `--server` capability route, passing the invite token on stdin
  (on the host, `aw id team accept-invite` takes it as an argument for the
  call's duration).
- **`oats.jira`** teaches the `jira-tasks` protocol and adds an advisory spawn
  hook that names the configured site and project.
- **`oats.linear`** provides JSON-first `oats linear` commands, the
  `linear-tasks` skill and an advisory spawn hook.

The pinned versions and each package's capabilities and souls are in the
[official catalog](official-catalog.md#the-packages).

### Adopting a minting root (oats.aweb, optional)

A person can adopt one of a deployment's minting roots: from then on, every
instance that root mints, and every instance those spawn, traces to that person.
OATS reads that and shows it; nothing else changes. A deployment that adopts no
root works as before: there is no setting for it, and nothing in OATS depends on
it. The provider's rules (what it records, joins, connect, and a mint waiting
for a signature) are in its README's
[Human attribution](https://github.com/awebai/oats-aweb/blob/main/README.md#human-attribution);
the contract is [the human IDs contract](design/2026-11-21-human-ids-contract.md).

- **When, and which roots.** OATS's adoption of hosted roots, every kind, waits
  for the contract's gate G2 (aweb's Cloud journey run,
  [§5](design/2026-11-21-human-ids-contract.md#5-gates)). Until §5 records G2 as
  passed, don't start one. `aw --identity-home <root>/.aw who --json` says which
  kind a root is:
  - **A fresh hosted root reads `no_human`.** From aw 1.36.53, a root made from a
    plain setup key carries its namespace's chain, with no person in it: a fresh,
    unadopted hosted deployment's normal state. aweb Cloud 0.8.80 and earlier
    refuse to adopt a root that already has a creation chain
    (`already_certified`), so such a root also waits for G3: the Cloud release
    aweb pairs with aw 1.36.59, which aweb names.
  - **A legacy chainless root reads `unknown`, `legacy_no_chain`.** That is a root
    made with aw 1.36.51 or earlier, or a member whose ancestry the registry
    couldn't verify. Cloud 0.8.80 accepts its adoption; OATS's adoption of it
    still waits for G2.
- **What it is.** One root, of one team, in one deployment. It's prospective: the
  instances that root mints after the adoption trace to the person, and instances
  that already exist keep their identity, address, memberships and history, reading
  no human. OATS doesn't respawn or re-sign them.
- **What it needs.**
  - aw 1.36.59 on every host that spawns from that root or joins teams from it. A
    join from an adopted root on an older aw stops before it mints anything
    (`E_ADOPTED_ROOT_AW_TOO_OLD`).
  - The oats.aweb release with human attribution (its README's Human attribution
    section).
  - For a legacy chainless root, any other host this deployment connects with
    `oats aweb connect`, connected first: connect refuses an inviter that has an
    identity chain (`E_CONNECT_CHAINED_INVITER`). A `no_human` root's connect is
    refused already, and adoption doesn't change that.
  - A person who has claimed a human ID and is a member of the root's team, with
    the authority aweb Cloud gives:
    - **The root's recorded creator,** while that creator has an active account
      and is a current member of the team. That creator is then the only person
      who can adopt it.
    - **A team admin, or an owner or admin of the owning organisation,** only when
      the root has no current creator. On aweb Cloud 0.8.80 and earlier, only when
      it has no recorded creator at all.
- **The steps.** One root at a time. The setup agent runs the commands, on the
  root's host, as the deployment's user, the two `aw id parent` commands from the
  directory that holds the two files; the person does three things in the aweb
  dashboard, signed in, with the root's team selected.
  1. The person chooses **Adopt** from the root's Chat or Messages pane. The
     dashboard shows an invitation id (I), the person's ID (H) and a domain (D).
  2. The agent writes the request, with I, H and D copied from the dashboard:
     ```bash
     aw --identity-home <root>/.aw id parent request --domain <D> --parent <H> --invitation-id <I> --out request.json
     ```
     The agent gives the person the fingerprint aw prints, over a channel other
     than the file. aweb's dashboard can't show the request's fingerprint yet, so
     there is nothing to compare it with there; the agent's ID and `did:key` the
     upload dialog shows come from aweb's own record, not from the file. When
     aweb's planned change (aweb-adql) shows the fingerprint before **Approve**,
     this step becomes a compare.
  3. The person uploads `request.json`, chooses **Approve and prepare response**,
     and downloads `response.json`.
  4. The agent installs the response:
     ```bash
     aw --identity-home <root>/.aw id parent import response.json --domain <D>
     ```
  `request.json` and `response.json` hold no secret. `<root>` is the directory the
  provider's `root` or `roots` setting names for that team.
- **The check.**
  - `aw --identity-home <root>/.aw who --json` answers `outcome: "nearest_human"`
    with the person's `human_id`.
  - `oats aweb setup --soul <soul> --check-only --json`, run as the provider runs
    its setup commands (in the deployment directory, outside an instance session),
    lists the root in `roots` with that attribution and no warnings.
  - Spawn one throwaway instance from that team and read its `attributedHuman` in
    `oats status --dir <deployment> --json`, or **Owning human** in the Desktop
    ([Attributed human](desktop-cli-api.md#attributed-human)); then retire it.
- **Limits.**
  - One adoption per root key. A host with several roots adopts each one.
  - No un-adopt. The way out is removing the root's membership of its team: the
    root can't mint there any more, the other members' memberships, mail and
    history are unchanged, and the adoption and the identities' ancestry stay as
    they are. A new root has a new key. The person removes it themselves, from
    their own terminal, with a fresh dashboard setup key for that team (one team;
    it expires 24 hours after it's made if unused, and 15 minutes after its first
    use), in `AWEB_API_KEY`, read without echo, never on the command line. It
    names the root's own team certificate:
    ```bash
    stty -echo; printf 'Setup key: '; read -r AWEB_API_KEY; stty echo; export AWEB_API_KEY
    aw id team remove-member --namespace <team namespace> --team <team name> --cert-id <certificate id> --json
    unset AWEB_API_KEY
    ```
    The setup agent gives the person `<certificate id>`, which is no secret. At the
    root, `aw --identity-home <root>/.aw whoami --json` gives the root's key
    (`did`), and `aw --identity-home <root>/.aw id team members --team-id <team
    id> --json` lists the team's certificates: the root's is the entry whose
    `member_did_key` is that key, and its `certificate_id` is the id. No agent
    holds or uses the setup key.
    Exit 0 doesn't prove the removal: aw doesn't read the answer as a statement
    about certificates. The check is the contract's G2 step 7: a fresh registry
    read by a surviving member that holds its own team certificate, never a
    grant seat (a grant home reads the service's roster, with no certificate
    ids). On that member, run `aw --identity-home <its .aw> id team members
    --team-id <team id> --json`. It counts only when all three hold: it exits 0;
    its `members` list that member's own `certificate_id` (the entry whose
    `member_did_key` is its `whoami --json` `did`), so the read can see
    certificates; and they don't list the root's. An error, or a list without
    certificate ids, is no answer. `--include-revoked` also shows the root's
    entry, with `revoked_at` set.
    This works once aweb's Cloud release with it is live; until then, the
    dashboard has no way to remove a root's membership alone. The contract's
    [§6](design/2026-11-21-human-ids-contract.md#6-revocation) gives the route,
    and its follow-up records the OATS deployment owner's word.
  - `oats aweb connect` refuses a chained inviter (`E_CONNECT_CHAINED_INVITER`),
    before any invite is minted; the provider's README gives the manual route. A
    fresh hosted root reads `no_human`, so for a fresh unadopted hosted
    deployment that refusal is the normal case: its connect ends there, where it
    used to fail at the other host's accept after the mint.
  - A mint can stop waiting for a signature (`native_agent_signature_pending`):
    the spawn fails and its home is kept, as the provider's README says.
- **Attribution is information.** No OATS behaviour (gating, routing,
  permission) depends on the human. OATS reads it and shows it.

## Building an integration

Building an integration is implementing a contract. In the framework's own
workspace, `oats-engineering-expert` leads contract design, reading the
integrations knowledge node (`oats/integrations-expert`).

**Any slot.**

- A namespaced capability manifest with exactly one `layer`.
- An `inject` that tells the instance what this implementation is and which
  skill to load before first use; skills that carry the craft.
- Commands that support `--json`; hooks only on the accepted events.
- `requires` for every host command and harness package, and `environment`
  for every launch variable contributed, under the vendor prefix. A
  requirement row may carry `when: { <setting>: <value> }` (it applies only
  when the effective setting matches), `minVersion` (a floor on the installed
  harness package) and `ifInstalled: true` (an absent package satisfies the
  row, so the floor applies only to an ambient extension).
- A setting that is a host fact (a custody directory, a state root) is
  declared `hostOnly: true`. The resolver then accepts it only from
  `oats-local.yaml` `settings.<cap>` and refuses it elsewhere
  (`E_WORKSPACE_SCHEMA`, reason `host-only-key`). The provider cannot enforce
  this itself: it receives one merged payload without provenance.
- A setting every deployment must share (which shared task list to use) is
  declared `committedOnly: true`, the mirror: the resolver refuses it from
  `oats-local.yaml` `settings.<cap>` and `--provider` (`E_WORKSPACE_SCHEMA`,
  reason `committed-only-key`), so it comes only from the workspace's
  `messaging:` or `tasks:`, a soul's slot payload or the manifest default.
  Kernels without the feature `settings-committed-only` ignore the flag.
- A slot provider that declares `binding` answers `oats readiness` through
  its `binding.check` command
  ([capabilities.md](capabilities.md#readiness-check-bindingcheck)).
- Package commands and hooks reach the kernel only through `OATS_CLI_BIN` and
  the JSON envelope, never by importing kernel files. A `node` path they
  write into anything that outlives them (settings, a unit, a script) is
  `OATS_NODE_BIN`, the node to write down, never `process.execPath`
  ([capabilities.md](capabilities.md#the-node-a-hook-writes-down)). Never name target souls
  in the manifest: which souls get a capability is configuration.

**Knowledge.** The capability owns its complete runtime and format, including
reader and capture instructions, judgment and delivery. Do not assume a soul
bundle, an attached worker, a Git store or a shared harvester. The
[authoring guide](knowledge-capability-authoring.md) describes the reference
model and how to adapt or replace it.

**Communication.**

- Mint an address on `spawn` with a `required` hook, and remove it on
  `retire`.
- Supply the roster; teach send, reply, chat and "read the event first" in the
  inject and skill; contribute launch arguments so the session is woken.
- Enforce the soul type's `reach` on both sides, state whether the address
  outlives the instance, and keep task coordination out.
- Emit `identity: { mode, alias, team, address|null, resident|null, grant?:
  { id, expiresAt, scopes } }` in the spawn meta (and in the launch meta when
  it renews). This is a messaging-layer contract: the kernel copies it
  through, from the capability whose recorded layer is `messaging`, as the
  principal the instance acts as (`oats status --json instances[].identity`,
  the roster's `identity:` line, `oats inspect --home … selected.identity`),
  adds `provider: <capability id>`, and never interprets `grant`. The choice
  of identity travels as `--provider <cap> identity.mode=…
  identity.resident=…`.

**Tasks.** Teach claim, update, block, hand off and complete; identify the
instance to the tracker in a way that survives it; keep conversation out.

Test an integration as a capability package: pin, sync, spawn and retire, with
the golden fixtures as the behavior oracle for the kernel side.
