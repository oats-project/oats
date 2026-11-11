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
  oats.okf: v6.0.1
  oats.aweb: v1.39.0
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
  `oats.aweb: v1.31.0` (or later), adding
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
