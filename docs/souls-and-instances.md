# Souls and instances

Souls and instances are the two layers the OATS kernel owns. A soul defines a
reusable specialisation. An instance is a named working incarnation, with its own
ID, home, work view and lifecycle; not necessarily one task or chat session.

An instance may be ephemeral, such as a developer or reviewer doing bounded work,
or long-running, carrying planning, investigation and domain understanding across
many tasks. Lifetime does not itself change the soul's identity. See the
[canonical knowledge and specialisation model](knowledge-theory.md) for how skills,
shared knowledge, working context and state differ.

Souls live in **member repos** of a [workspace](workspaces.md) and are
discovered over Git; their capabilities are resolved by `from:` and copied whole
into each instance. This page is the soul's and the instance's anatomy under
that model.

## Quick map

| Thing | Location |
|---|---|
| Shared declaration | `oats-workspace.yaml` in the host repo; `oats-membership.yaml` in every member |
| Per-machine config | `<deployment>/oats-local.yaml` (uncommitted; [configuration.md](configuration.md)) |
| Package lock | `<deployment>/oats-lock.json` ([packages.md](packages.md#lock-v3)) |
| Soul | `<member repo>/souls/<name>/`: `soul.yaml`, `AGENTS.md`, `CLAUDE.md → AGENTS.md`, `skills/` |
| Member capability | `<member repo>/capabilities/<name>/oats.json` (latest state) |
| Package capability | `<package repo>/oats-package/capabilities/<name>/` (versioned) |
| Instance home | `<deployment>/agents/<soul>/instances/<instance>/` |
| Instance operating doc | `<home>/AGENTS.md` (generated) |
| Instance skills | `<home>/.agents/skills/` |
| Instance modules | `<home>/.oats/modules/<capability>/` (the copies this instance runs) |
| Instance `oats` | `<home>/.oats/bin/oats` (a link to the kernel that last launched it) |
| Instance record | `<home>/instance.json` (`modules`, `providers`, `workspace`, `teams`) |

## Soul anatomy

A soul is durable and committed. It is the part you review, improve, and keep.

```text
<member-repo>/souls/<name>/          # discoverable in the workspace by convention
  soul.yaml            # schemaVersion 2: name, description, work, capabilities, provider payloads
  AGENTS.md            # canonical operating doc
  CLAUDE.md → AGENTS.md
  skills/              # skills specific to this expert
  okf.json             # if the soul uses oats.okf: { version: 1, owner, owns: ["<base>/<node>"], reads: […] } (the provider's, not the kernel's)
```

(A deployment's `agents/<name>/souls/<commit12>/` has the same shape; a member
soul is fetched there at its discovered commit before its first spawn, and
`agents/<name>/soul` points at the current commit.)

### `soul.yaml` v2

```yaml
schemaVersion: 2
name: release-manager                     # must equal the directory name
description: Cuts, verifies and announces releases.
work: worktree                            # worktree | checkout | directory | workspace

capabilities:                             # WHERE each capability comes from: a location, never a version
  acme-release-tooling: { from: here }    # here = this soul's own repo
  acme-warehouse-access: { from: github.com/acme/data }   # a canonical repo key of a confirmed member
  acme-deploy: { from: package }          # provided by a package pinned in the workspace's packages:
  acme-house-style: off                   # removes a workspace default

knowledge:                                # provider payloads: opaque to the kernel, consumed by the slot's capability
  harvest: off                            #   (what the soul owns and reads is in this directory's okf.json)
messaging:
  channels: [acme-eng]
tasks: none                               # `none` empties the slot (drops the workspace default)

compatibility:                            # optional floors on PACKAGE versions: constraints, not sources
  oats.okf: ">=4.0"

launch: { harness: claude, model: claude-opus-5-5 }   # optional (0.30): what the role should run on
background: true                          # optional: list new instances under the clients' Background section
```

| Key | Meaning |
|---|---|
| `name`, `description`, `work` | Required. `work` is the work mode below. |
| `capabilities` | `<cap>: { from: here \| <repo key> \| package }` or `<cap>: off`. Composed over `defaults.<slot>` ⊕ `defaults.capabilities`; the soul wins. |
| `knowledge` / `messaging` / `tasks` | The slot's provider payload (true of every instance of the soul), or `none`. Merged with `oats-local.yaml` `settings.<cap>` and `spawn --provider <cap>`; the provider refuses keys its manifest does not declare. For `oats.okf`, what the soul owns and reads lives in `souls/<name>/okf.json`. |
| `compatibility` | `<cap>: <semver range>` checked against the locked package version (`E_COMPATIBILITY`). |
| `launch` | Optional (0.30): `{ harness: pi \| claude \| codex, model? }`, the role's launch preference. Only a harness and a model: args, env, yolo and the executable stay host facts. Each machine may override it (`oats-local.yaml` `souls.launch`), and spawn flags win over both ([launch preferences](configuration.md#launch-preferences)). Add it to a committed soul only once every deployment runs 0.30. |
| `background` | Optional `true \| false` (default `false`, feature `instance-background`): the role's default placement. `true` lists a new instance under the clients' Background section; presentation only, never identity or policy. `spawn --background` / `--no-background` win, the value is recorded in the home at spawn, and `oats instance background <instance> on\|off` changes it later ([Background instances](desktop-cli-api.md#background-instances-oats-instance-background)). Add it to a committed soul only once every deployment reading it runs the release that adds it: an earlier kernel refuses the key. |

Schema: [`soul.schema.json`](soul.schema.json). Which teams a soul joins is the
deployment's choice (`oats-local.yaml`, [workspaces.md](workspaces.md#teams)),
and yolo and the launch configuration are spawn-time host choices
(`--yolo`, `--launch-config`, or a launch configuration in
`oats-local.yaml`), not soul identity. The harness and model are a soul's
*preference* at most (`launch:`), which each machine overrides and spawn flags
(`--harness`, `--model`) win over.
A child-spawn policy is a spawn flag too (`--no-child-spawns`).

A soul never runs by itself. It is incarnated as an instance. Editing a soul
is a code change, reviewed in its repo.

### OATS operational knowledge is a capability

An agent's knowledge of OATS itself (status, spawn, retire, finding other
souls, and keeping its messages to other instances few and short:
`/oats-token-saving`) is ordinary capability content: **`oats.core`** (package
`oats.framework`). Workspaces give it to every soul through
`defaults.capabilities: { oats.core: { from: package } }`; a soul may say
`oats.core: off`. **`oats.setup`** (same package) carries the whole-architecture
knowledge an onboarding expert needs, **`oats.onboarding`** (same package)
is how the package soul `oats-setup-expert` tailors a new workspace to its use
case, **`oats.coordination-setup`** (same package) is how it shapes OATS's
coordination practices to that organisation, and **`oats.support`** (same
package)
is the support desk role: a publicly reachable soul that tickets requests and
hands them to a support maintainer. None of them is kernel magic; the kernel still
composes its own instance-boundary and work-mode briefings, and the "You run
on OATS" briefing is `oats.core`'s inject: a soul without `oats.core` gets no
OATS operating instructions, and `oats doctor --soul` says so. Its capability
markers' `src=` is home-relative (`.oats/modules/<cap>/<inject>`), composed by
the same path as `oats inspect --soul --instructions`; kernel markers keep the
installed package's path.

## Instance anatomy

An instance has a lifecycle, but need not be short-lived. It is the identity of
one instantiated soul while its assignment is alive. Supported session
continuations, compactions and restarts can preserve that continuity.
Retirement should account for valuable context and unfinished work, not assume
an experienced instance is cheap to replace.

An instance has a home directory, a task, and a worktree when the work mode
needs one. Its runtime setup is composed from the canonical soul plus **its own
full copy** of every capability the soul resolved to:

```text
<agents-root>/<soul>/instances/<instance>/
  AGENTS.md                        # generated: soul AGENTS.md + each module's inject + kernel/work-mode blocks
  CLAUDE.md → AGENTS.md
  .agents/skills/                  # canonical skill tree, flat: the soul's skills and every module's, full copies
    <skill>/SKILL.md               # one level deep, where every harness discovers skills
  .claude/skills → ../.agents/skills
  .oats/modules/<capability>/      # the whole capability: oats.json, bin/, injects/, skills/ (hooks run from here)
  .oats/bin/oats → <kernel>/bin/oats.mjs  # the kernel that last launched this home: first on the harness's PATH
  work/                            # worktree, checkout symlink, attached tree, or private directory
  TASK.md                          # briefing and task (0600; the home itself is 0700)
  instance.json                    # provenance (below); `soulDir` = the soul directory hooks get as OATS_SOUL
  STATE.md, log.md, notes/         # optional, from the knowledge capability
```

Instances are local runtime state and normally gitignored
(`agents/*/instances/`). Souls travel with their repository; several
deployments can incarnate the same soul without collisions, because instance
homes, logs, notes, branches and messaging identities are local.

### `instance.json`: provenance is recorded, not declared

Besides the instance's identity, repository, branch, lineage, launch recipe and
composed skills and instructions, a spawn records provenance. The following is a
**historical 4.x-spawned home**, not the settings to use for new oats.okf 5.0
spawns: its version and provider payload remain recorded after a pin changes.
For current settings and the respawn/cleanup sequence, see [knowledge.md](knowledge.md).

```json
{
  "modules": {
    "acme-release-tooling": {
      "from": { "kind": "member", "repoKey": "github.com/acme/agents", "commit": "3f2a9c1e…" },
      "commit": "3f2a9c1e…", "digest": "sha256-…", "materializedAt": "2026-09-24T10:12:44.118Z"
    },
    "oats.okf": {
      "from": { "kind": "package", "package": "oats.okf", "version": "4.1.1", "commit": "e1d604f7…", "integrity": "sha256-…", "repoKey": "github.com/awebai/oats-okf" },
      "commit": "e1d604f7…", "digest": "sha256-…", "materializedAt": "2026-09-24T10:12:44.201Z"
    }
  },
  "providers": {
    "oats.okf": { "bindings-file": "/Users/ana/.oats/okf-bindings.json", "state-dir": "/Users/ana/.oats/okf", "harvest-runtime": "claude" },
    "acme-release-tooling": {}
  },
  "workspace": {
    "key": "github.com/acme/agents", "commit": "3f2a9c1e…", "resolution": "20ec8ec527311d71d0973086",
    "soul": { "repoKey": "github.com/acme/agents", "commit": "3f2a9c1e…" }
  },
  "teams": [{ "label": "ana-acme", "team": "ana-acme:ana.aweb.ai", "default": true, "from": "local", "via": ["default", "local"] },
            { "label": "engineering", "team": "engineering:acme.aweb.ai", "default": false, "from": "shared", "via": ["workspace"] }],
  "defaultTeam": { "label": "ana-acme", "team": "ana-acme:ana.aweb.ai", "from": "deployment" }
}
```

- `modules.<cap>`: where the copy came from, at which commit, and its content
  digest. `oats status` compares these with the workspace's current state and
  shows `moved` / `missing` per module (drift is shown, not prevented).
- `providers.<cap>`: the merged provider payload the capability was bound with
  (manifest defaults ⊕ the workspace's `messaging:` or `tasks:` ⊕ soul ⊕
  machine settings ⊕ `--provider`), so a later inspection can tell
  which instance holds a retained seat or a one-off state root. `spawn
  --preview` shows the same map before anything exists, as `settings.<cap>`,
  beside `providers` (the `--provider` flags as given).
- `workspace`: the workspace commit observed at spawn, the soul's repo/commit,
  and the **resolution revision** the spawn decision bound. `oats status`
  compares `workspace.soul` with the member's current commit too: `soul: <name>
  from <member> @ <c7>  [member moved since …]` (`--json`: `instances[].soul`).
- `teams` / `defaultTeam`: the soul's teams at spawn, exactly as the providers
  received them (mapped teams only, each with `via`: why the soul may join it)
  and its default: evidence, never rewritten.
  A running home's hooks and messaging commands read the teams live
  ([capabilities.md](capabilities.md#teams-in-the-provider-environment)).

A running instance never changes under itself; a stopped one can be moved to
the locked package versions with `oats instance upgrade`. Member modules and
the soul body still require a new spawn. See
[upgrading package modules](upgrading.md#moving-existing-homes-to-locked-package-versions).

### The harness starts normally

OATS is a skill contributor, not a skill sandbox. The harness (pi, Claude Code,
Codex) starts with cwd = the instance home and its **own** skill discovery
intact: it sees, nearest first, the instance's `.agents/skills/` (soul skills
and the copied capability skills, all flat at `.agents/skills/<skill>/SKILL.md`,
the one level deep Claude Code discovers through `.claude/skills`), the repo's own `.agents/skills/` once it
works in `work/`, and whatever the operator keeps at machine level. All three
are intended. Two *composed* skills with one name is a spawn error naming both
capabilities (`E_SKILL_DUPLICATE`); a composed skill versus an ambient one is
the harness's own precedence. The `CLAUDE.md → AGENTS.md` and
`.claude/skills → ../.agents/skills` aliases are kept. OATS composes
instructions and pins model/provider settings; it excludes nothing.

### Unattended launches: folder trust

Claude Code and Codex ask before they work in a folder they have not seen, and
every instance home is new. A launch stopped at that prompt waits for a human,
so the operator trusts the **deployment directory** (where `oats-local.yaml`
is) once per harness configuration file. Launches only read native
configuration. The explicit `oats harness trust --dir D --plan` previews the
entry in every file a launch reads: the ambient one and each launch
configuration's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The same command without
`--plan` applies it with a deployment audit; it never creates a launch
configuration's directory. See [native trust](harness-trust.md) for safe
operation and partial-failure recovery.

- **Claude Code** looks for an accepted entry for its folder or an ancestor, up
  to a Git root. An intervening repository can prevent deployment-root inheritance;
  the command does not automatically trust another root. The native field is
  `projects["<deployment>"].hasTrustDialogAccepted` in `~/.claude.json`
  (`$CLAUDE_CONFIG_DIR/.claude.json` when the launch's environment sets it:
  its launch configuration, else its tmux pane's, never the calling
  process's in its place).
- **Codex** applies only an exact entry: a trusted parent does not cover the
  folders below it. The explicit deployment-root command records
  `[projects."<deployment>"] trust_level = "trusted"` in
  `~/.codex/config.toml` (`$CODEX_HOME/config.toml`, from the launch's
  environment as for Claude). With that entry, or one
  for an ancestor of the deployment, each codex launch trusts its own new home
  for that session (`-c 'projects={"<home>"={trust_level="trusted"}}'`) and
  leaves the config file unchanged. A yolo launch always does this. The plan
  re-reads the entry at every start.
- Every codex launch also passes `-c check_for_update_on_startup=false`, so
  Codex's "Update available" choice cannot block it.

When the file a claude or codex launch reads does not trust the deployment,
the spawn says so (text and `--json` `warnings`): `<harness> folder trust is
not established in <file> (<where the launch gets that file from>): oats
harness trust --dir <deployment>`. A missing
entry does not prove a prompt, so it does not say the session will stop.
`oats readiness` reports the same in `checks.configured` (code
`harness-trust`, not required), and a passing item naming the file when trust
is established. When the file cannot be established, or no pane exists to
read it from, both say that instead
([launch-time checks](harness-trust.md#launch-time-checks-and-readiness)).

[The development-channel confirmation](configuration.md#the-development-channel-confirmation)
does not cover folder-trust prompts, and never writes trust settings.
A blocked or incomplete prompt outcome preserves the home and process even
though its metadata says `launched:false`; inspect that endpoint before any
recovery. See [launch prompt outcomes](execution-targets.md#launch-prompt-outcomes).

### Codex tool commands and the instance environment

Codex can run tool commands under its shared app-server daemon rather than as
children of the session OATS launched, and then they do not inherit the
session's environment. Codex (0.157.1) runs a session that has `-c` overrides
embedded, without the daemon, and every kernel codex launch has them, so an
OATS codex session does not appear in `codex agents`. So that the environment
does not depend on this, a codex launch also sets it for tool
commands explicitly with `-c shell_environment_policy.set.<NAME>="<value>"`:

- the instance: `OATS_INSTANCE`, `OATS_INSTANCE_HOME`;
- every capability's launch environment (for example the messaging
  provider's identity home and delivery mode);
- the launch configuration's literal values. A reference's value never goes
  on a command line.

`PATH` comes from the launching shell, with the home's `.oats/bin` first, so
only the execution passes it; the persisted command does not carry it. Codex
runs tool commands through the user's login shell, and a profile that prepends
directories puts those entries ahead of `.oats/bin`. A second `oats` in such a
directory is found first.

A capability command (`oats <namespace> …`) runs in the instance home that
`OATS_INSTANCE_HOME` names, else `OATS_HOME`. With neither set, it finds its
instance from the working directory. It uses the nearest enclosing directory laid out as
`<agents-root>/<soul>/instances/<name>` whose `instance.json` records that
name, and validates it like a home named by the environment. The walk uses the
directory as the shell names it (`$PWD`). That matters for an attached
instance, whose `work/` links into its owner's tree: below it, the physical
path is the owner's. A process that has no `$PWD` there would act as the
owner, so an attached instance runs capability commands from its home.

Inside an instance home the namespace is that home's. A `--soul` naming
another soul is refused (`E_HOME_MISMATCH`), and a namespace the home does
not have is `E_UNKNOWN_COMMAND`. Both name the home and what chose it (the
variable, or the working directory). To run a command as a spawn of another
soul would, run it from the deployment with `OATS_INSTANCE_HOME` and
`OATS_HOME` unset.

## Lifecycle

### Spawn

`oats spawn --help` lists the existing spawn flags and their conditions; the
spawn section of `oats help` contains the same inventory. Both work outside a
deployment. Compatibility and internal inputs are labelled, including the
locally refused legacy instance selector. For preview confirmation and receipt
replay, see the [spawn decision and apply contract](desktop-cli-api.md#the-decision).

```bash
oats spawn release-manager --name cut-3-2-manager --task "…"        # a soul of a confirmed member
oats spawn release-manager --preview --json                        # decide everything, create nothing
oats spawn release-manager --provider oats.aweb identity.source=/abs/path/to/retained/.aw   # instance-level payload
```

An instance is named exactly `--name <slug>`, or `<soul>-<purpose>` with
`--purpose`; with neither, the kernel numbers it. The convention for a name a
person or an agent chooses is `<descriptive>-<role>` through `--name`: a few
words for the instance's work, then the soul's role, the last word of the
soul's name after any package qualifier (`--name desktop-improvements-expert`
for an `oats-desktop-expert`). `--purpose` derives the name from the soul, for
automations and scripts that know only the soul and a purpose.
Names are unique per deployment (a workspace-model deployment has one agents
root): a derived name in use gets `-2`, `-3`…; an explicit `--name` in use is
refused (`E_INSTANCE_NAME_TAKEN`). The Desktop's spawn dialog adds the role to
a typed name.
`oats spawn <soul> --preview --suggest-name --task-file <f>` asks the soul's
own harness for the descriptive words, from the task, in one call that starts
none of the user's MCP servers, hooks, plugins or extensions. Claude Code's
built-in plugins, the host's managed-policy hooks and pi's credential commands
are the stated exceptions; a claude login through `apiKeyHelper` is not read,
so that user's name stays numbered (`harness-failed`). The preview then answers for
`--name <descriptive>-<role>`, de-duplicated the same way. On claude and pi
only; any other harness, and any failure of the call, leaves the name numbered
and says why
([The suggested name](desktop-cli-api.md#the-suggested-name-feature-spawn-suggest-name)).
`--background` or `--no-background` says whether the clients list the instance
under their Background section, over the soul's `background:`; with neither,
the soul decides, and a soul that says nothing means no. The home records it
at spawn (`.oats-background.json`), so a later soul edit moves no existing
instance; `oats instance background <instance> on|off` does. Both flags
together are `E_BAD_ARGS`.
An apply takes `--suggest-name` too (without `--name` or `--purpose`): the
machine that spawns makes the same call, names the instance
`<descriptive>-<role>`, de-duplicated the same way, and numbers it on any
failure; the result's `naming` says which, and the apply may take up to 20 s
longer ([On an apply](desktop-cli-api.md#on-an-apply-feature-spawn-apply-suggest-name)).
Without the flag an apply is numbered, as before.
`oats instance suggest-name --soul <soul> --task-file <f>` asks for the same
words on this machine for a spawn that will land on another (the Desktop's
dialog, spawning through `--server`): the soul only gives the role and needn't
exist here, nothing is written or reserved, and the name is not made unique,
which the landing host does
([A name for a spawn elsewhere](desktop-cli-api.md#a-name-for-a-spawn-elsewhere-oats-instance-suggest-name)).

From a deployment (where `oats-local.yaml` is), a spawn: reads the local file →
discovers the workspace over its remotes and confirms membership → finds the
soul among the confirmed members, `external:` souls and the locked packages'
souls (an ambiguous bare name is `E_SOUL_AMBIGUOUS`, naming each qualified
form: `<member>/<soul>` or `<package>/<soul>`; a soul listed in
`oats-local.yaml` `souls.disabled` is `E_SOUL_DISABLED`) → fetches the soul's
source into `<agents-root>/<soul>/souls/<commit12>/` at its commit (a package
soul at the locked commit, verified against the lock's digest — see
[package souls](packages.md#package-souls); the home links that
directory; `<agents-root>/<soul>/soul` points at the current one) → resolves
every capability by
`from:` (member = latest, package = locked) → creates the home →
**materializes each module whole** into `.oats/modules/` and copies its skills
into `.agents/skills/` (a transaction: any failure leaves nothing behind) →
composes `AGENTS.md` → records `modules`/`providers`/`workspace` in
`instance.json` → prepares `work/` → runs the modules' spawn hooks (from their
copies) → writes `TASK.md` → launches the harness in tmux. The committed soul is
unchanged. This is a normal agent process with its own home and tools, not a
subagent call.

`--preview` reports `modules[]` (`from`, `layer`, `changedSince` the newest
previous instance of the soul), `teams` and `defaultTeam` (the soul's teams here), the `resolution` revision, the decision
it would bind, `providers` (the `--provider` map exactly as given) and
`settings.<cap>` (the merged payload each provider's binding will receive);
the apply refuses with `E_DECISION_STALE` if a member
moved in between. `--provider <cap> key=value` (repeatable; dotted keys nest)
must name a capability the soul resolves (`E_CAPABILITY_MISSING` otherwise) and
needs a workspace deployment. Spawn takes one soul and the flags it reads:
another positional, or a flag it does not know, is `E_BAD_ARGS` naming the
argument, before anything is created (a bare `key=value` is a provider
setting given without `--provider <capability>`). The full DTOs are in
[desktop-cli-api.md](desktop-cli-api.md#workspace-model-workspaceapi-2).

Examples of spawn hooks:

- `oats.okf` validates the soul's declaration and the bindings, and creates the
  instance knowledge files. With harvest on, it also registers a durable source
  and its harvest schedule; with harvest off (the default) it registers nothing.
  Missing knowledge configuration is an error, never permission to bootstrap an
  empty substitute.
- `oats.aweb` mints a messaging identity or, with
  `--provider oats.aweb identity.source=/abs/path/of/the/.aw/to/retain`, re-takes a retained
  one for exactly this instance.

### Work

The instance works in `./work`. With `oats.okf` it also keeps `STATE.md`
current, appends milestones to `log.md`, and captures non-obvious insights in
`notes/`.

It consults accepted knowledge remotely, at its accepted state, with
`oats okf index`, `cat` and `search` (the `okf-consultation` skill), and never
writes accepted knowledge; this is instruction, not an OS sandbox. With harvest
on, an independent harvester judges the instance's notes and session record and
proposes promotions by pull request. See [knowledge](knowledge.md).

### Spawning and coordinating with other agents

OATS agents can run `oats spawn` when their task, their human or their
soul's capabilities call for another instance. The spawned agent is another
full OATS instance, with its own soul, home, worktree, and lifecycle.

Spawn lineage is **explicit** and relation-based:
`oats spawn --relation child|sibling|parent|unrelated --relative-to <instance>`
declares what the new instance IS to an existing one (`--parent <instance>` is
sugar for `--relative-to <instance> --relation child`):

- **child**: nests under the anchor: `parentInstance` = anchor.
- **parent**: the NEW instance becomes the anchor's parent: it inherits the
  anchor's old lineage slot, and the anchor's `instance.json` is re-pointed so
  its `parentInstance` is the new instance (a reviewer/maintainer of your work
  sits above you). Retirement splices lineage: when any instance retires,
  instances pointing at it (parent or sibling links) inherit its COMPLETE
  surviving lineage (both its parent and sibling links, whichever edge type
  pointed at it), so a retired parent-relation maintainer hands its children
  back to the parent it displaced (restoring absorbed sibling links too), and
  no instance is left pointing at a missing one. The splice scans the
  deployment's agents root.
- **sibling**: a peer in the anchor's cluster: it shares the anchor's parent
  when one exists; when the anchor is a root, the new instance records an
  explicit `siblingInstance` link so the cluster is still derivable from
  `oats status --json` (`parentInstance` + `siblingInstance` edges).
- **unrelated** (default): no link, top-level.

Attached-mode spawns are ALWAYS children of the owner of the shared work tree
(the instance in whose home the tree is, as its `work/` or as one of its
extra trees: see [`attached`](#attached--another-instances-tree)),
because an attached agent serves that owner; relation flags other than a
redundant child-of-owner are rejected.

`--same-work` (feature `instance-same-work`) records that the new instance
does the same work as its parent; clients draw the parent→child line for an
instance that carries it. It is bound to the parent the new home records,
whichever relation gave it: a child, a sibling of an anchor that has a
parent, a `parent` relation whose anchor had a parent (the new instance
inherits it), or an attached spawn (the owner). A spawn that would record no
parent (unrelated, a sibling of a root, a `parent` relation over a root
anchor) is refused with `E_BAD_ARGS` before anything is created, a preview
included. The flag is the home's own file, `.oats-same-work.json`, naming the
parent it was set against, and it is on only while that is still the home's
recorded `parentInstance`: after a reparent (a retire's lineage splice, or a
`parent` spawn re-pointing its anchor) it reads off. It survives a restart, a
stop and a start, a resume and `oats instance upgrade`; only `off` or
retirement clears it.

`oats instance same-work <instance> on|off` sets or clears the flag on an
existing instance, addressed as `oats instance color` addresses it and routed
with `--server`. `on` needs a recorded parent and binds the flag to the
current one, so it also rebinds after a reparent; `off` always succeeds. An
instance with the flag on carries `sameWork: true` on its `oats status
--json` row; otherwise the key is absent. The answer, the errors and the
remote relay are in
[desktop-cli-api.md](desktop-cli-api.md#same-work-as-the-parent-oats-instance-same-work).

`spawnOrigin` records the caller independently of these links. For new spawns
from OATS 0.64.0, it is `instance` when the caller's `OATS_INSTANCE` and/or
`OATS_INSTANCE_HOME` resolve consistently to an extant home in this deployment;
otherwise it is `operator`. A stopped home counts. A shell, Desktop or console
caller without that context records `operator` even with `--parent`; an instance
caller records `instance` even without a relation. A shell inheriting valid
instance context also records `instance`. This is informational attribution,
not a security boundary or a permission check. Existing instances keep their
recorded value, including the relation-based meaning recorded by older kernels.
For a remote spawn (`--server`), attribution uses the host-side caller context;
caller identity is not forwarded, so the origin is normally `operator`.
See [the caller resolution rules](desktop-cli-api.md#spawn-origin).

Agents spawning sub-agents should pass `--parent "$OATS_INSTANCE"` (or the
relation that fits).

If the workspace has a messaging capability such as aweb, spawned instances
can also receive identities and coordinate with each other automatically. The
tasks capability can provide shared work state while messaging provides conversation.

### Cloning an instance

A clone is a new instance of an existing instance's soul that starts from a
curated brief of what that instance knows, for a new goal. It is not a copy of
the source's home. Cloning is the official
[`oats.cloning`](https://github.com/awebai/oats-cloning) package, not a kernel
verb; a soul that may request clones composes it
(`oats.cloning: { from: package }`). An instance with the capability runs:

```bash
oats cloning request <source> --goal-file goal.md --relation independent|child|sibling|parent \
  [--relative-to <instance>] [--name <slug>] [--transcript exclude] [--base source|default|<ref>]
```

From the deployment directory the operator adds `--soul oats.cloning/cloner`.
The relation is required and is the kernel's spawn relation of the clone to the
anchor (`--relative-to`, the source by default); `independent` is the kernel's
`unrelated` and takes no anchor. The request spawns a short-lived
`oats.cloning/cloner`, which reads the source (its home files, work state and,
unless excluded, its transcript), writes the brief, spawns the clone with its
own identity, reports and retires itself. Only instances on this host can be
cloned. [Reusing working understanding](knowledge-theory.md#reusing-working-understanding-context-handoffs-and-cloning)
says what a clone carries and what it does not.

### Retire

Retirement runs active capability retire hooks in reverse spawn order before the home disappears. The aweb
integration deletes the instance identity here. With harvest on, `oats.okf`
takes a final capture of notes and the session record into durable custody; an
incomplete capture keeps the home for a retry. Retirement never waits for a
model or GitHub: processing continues after the home is gone.

A spawn that is killed after its spawn hooks started and before it wrote the
home's record (SIGKILL, a container stop, a dropped connection) leaves a home
`oats retire` still cleans up: the spawn records, before its first spawn hook,
which retire hooks a retire must run, and the retire runs them before it
removes the home. A home whose record does not say which retire hooks to run,
and that has no such marker, is refused with `E_UNIDENTIFIED_INSTANCE_HOME`
and kept; `--force` removes it without running a hook, once what its
capabilities registered is cleaned up by hand
([A spawn in progress](capabilities.md#manifest)).

A retire hook's warning, such as an action someone must still take, is in the
retire's `warnings` and stays readable after the home is gone: each one is a
`retire-warning` event in the instance's workspace log, read with
`oats instance events <instance>` ([Events](desktop-cli-api.md#events)).

`oats retire <instance>` reads these flags: `--plan`, `--plan-revision <rev>`
with `--idempotency-key <key>`, `--home <path>`, `--dir <d>`, `--server <id>`,
`--self`, `--discard-worktree`, `--keep-dir`, `--force` and `--json`. Any
other flag, and any argument after the instance, is refused with `E_BAD_ARGS`
before anything happens: before a plan is read, a child is stopped, a hook
runs, or a routed retire is sent to its server. The refusal names the flag
(`oats retire: unknown flag --keep-dirs`) and prints the usage, so a mistyped
`--keep-dir` never removes the home.

One retire of an instance runs at a time. A retire holds the instance's claim
from the moment it has resolved the home until it ends: the file
`.oats-retirement/claims/<instance>.lock` in the agent's instances directory,
beside the homes, which names its holder by pid and start time. Any other
retire of that instance (plain, guarded or `--self`, `--force` included) is
refused at once with `E_LIFECYCLE_BUSY`, before it stops anything, copies
anything or runs a hook: a retire hook releases things that exist once, such
as a messaging identity or a scheduled job. A self-retire's completion
waits for the retire that scheduled it to release the claim, for up to ten
minutes (OATS 0.53.0; before, it gave up after 3 s). Beside any other
holder it is refused the same way, after it has waited up to 3 s. A self-retire that is scheduled counts from the moment it is scheduled,
while its completion lives. A retire killed while it holds the claim leaves
the file behind until that name is retired again: the next retire takes the
claim over, because its holder is verifiably gone, and the file is safe to
remove by hand once its pid is gone. A holder that was killed and that its
parent has not reaped (a zombie) is gone too: nothing waits for that reap. The claim does not end what the killed
retire left running: one of its retire hooks may still be running when the
next retire takes the claim over and runs the hooks again (#865). A holder whose start time cannot be
read is never taken for gone; the refusal names the pid, the file and the
way out.

A stop holds the same claim (OATS 0.52.0, #866, #890). `oats instance stop
<instance> --apply` takes the claim of the instance and of every recorded
child it would stop before it stops the first one, and holds them until it
has written its receipt. So a stop and a retire of one instance never run
together: a stop that meets a retire is refused with `E_INSTANCE_RETIRING`, a
retire or a stop that meets a stop with `E_LIFECYCLE_BUSY`, at once and
before anything is stopped, run, copied or written. A stop that is killed
leaves its claim files, and they refuse nothing: the next stop or retire
takes them over. Before 0.52.0 a stop marked the home with a file inside it,
`.oats-stop-pending.json`, that named no holder: a killed stop left every
later stop of that instance refused until the file was removed by hand, and
a stop wrote into a home that a retire was inspecting or removing. That
name stays reserved: a file an older OATS left there refuses nothing and is
removed by the next stop. A retire does not hold the claims of its recorded
children: it stops each one, and that stop takes the child's claim for as
long as it lasts; a child held by someone else's stop or retire is a child
that did not stop (below). `oats worktree add` reads the claim and is
refused while a retire of the home runs (`E_INSTANCE_RETIRING`). `oats
session start` and `restart` do not read it yet, and `oats status` does not
show it. Who answers what to whom is one table in
[desktop-cli-api.md](desktop-cli-api.md#lifecycle-pairs); the refusals of a
retire are in [desktop-cli-api.md](desktop-cli-api.md#retire).

Recorded children (the instances whose recorded parent chain reaches this
one) are stopped first, never escalated, and kept: their homes stay. If one is
still running after the grace, or its stop cannot be established, retire
refuses with `E_CHILDREN_RUNNING` and retires nothing; `--force` does not
bypass it. This holds for plain, guarded and `--self` retires alike
([desktop-cli-api.md](desktop-cli-api.md)). Who is a child is read from each
home's `instance.json`: a home whose record cannot be read is never stopped
as anyone's child, by a retire or by `oats instance stop`. Its session may go
on running after its parent is retired, and the retire's answer does not name
it; `oats status` is where it shows.

Before any retire hook runs, retire preserves the instance's uncommitted and
unmerged work: a verified recovery under `.oats-retirement/recovery/`, named in
the summary. One retire writes at most one recovery directory. A worktree
recovery is a standalone clone that carries the
repository's local exclude rules (`info/exclude`, a configured
`core.excludesFile`), its `info/attributes` and the settings that change what
status reports (`core.fileMode`, `core.ignoreCase`, …), so its Git status
matches the source's. Its files are the worktree's, entry for entry: each top
level of the clone (the worktree's, and each nested repository's) is made the
source's, so a tracked entry the source deleted or renamed is not left in the
copy. The copy's verification compares every entry's bytes, leaving out only
the worktree's own `.git` and those of the nested repositories the copy
rebuilds from a clone; any other entry named `.git` (a dangling link, or the
Git directory of a repository inside a nested one, carried as files) is
compared like any other. A recovery that
cannot be verified refuses with `E_WORK_PRESERVATION_FAILED` and keeps the
home. **`--force` does not skip work preservation.** It forces only past a
missing or unusable cleanup marker and past incomplete hook cleanup
([capabilities.md](capabilities.md)).

The recovery holds the state before the retire hooks at its top level, and
what the hooks changed under `after-hooks/`:

```text
<recovery>/
  recovery.json
  home/               the home before the retire hooks
  repo/ or work/      the work before the retire hooks (worktree, directory)
  after-hooks/
    home/             the home again, only if a hook changed home bytes
    repo/ or work/    the work again, unless it is proven unchanged
```

After the hooks, retire copies again each part the hooks moved. The home
moved when its bytes did. The work is copied again unless it is proven
unchanged. A Git status with the same rows is not that proof: a hook can
rewrite a file that was already modified, and the row stays the same. In
directory mode the work state is the bytes of `work/`, with the permission
bits of each entry and of `work/` itself. In worktree mode it
is what a work copy of the worktree holds, each file read where the copy
reads it. The copier reads the paths Git prints for it (the Git directory,
the common directory, `core.excludesFile`, the top level) exactly as Git
prints them, white space included, and a worktree's `.git` file as Git
parses it, so it copies the files Git reads:

- its Git status, the ref its HEAD is on and the commit, and, when the copy
  is made detached, the branch the repository's own HEAD is on;
- its index: the entries (what `git ls-files -s` lists, with the
  skip-worktree and assume-unchanged marks), the resolve-undo records (what
  `git ls-files --resolve-undo` lists) and the index file's permission bits;
- what the copy takes from the Git directories as files, each with its bytes
  and its permission bits: the state of an operation in progress (a merge, a
  rebase, a cherry-pick, a revert, a bisect), `info/attributes` and the
  stash's log. A link at one of the operation's entries is copied as the same
  link, also one that leads nowhere;
- the refs an operation leaves that are not files where the refs are stored
  in the reftable format: `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`
  and `AUTO_MERGE`, each written into the copy through Git at the same object
  id. The copy itself always stores its refs as files, whatever format the
  operator's Git configuration or environment gives a new repository;
- its tags and its stash. Where the stash's log is not a file (the reftable
  format), its entries are read through Git and stored again in the copy,
  oldest first, each with its message, so `git stash list` reads the same;
- its exclude rules (`core.excludesFile` with the file the copy reads for it,
  and `info/exclude`) and the settings that change what `git status` reports
  (`core.fileMode`, `core.ignoreCase`, `core.precomposeUnicode`,
  `core.symlinks`, `core.autocrlf`, `core.eol`);
- the bytes and the permission bits of its files, Git metadata left out, and
  each symbolic link as itself: its raw target and its own permission bits.
  A link is recreated with its target and then given its source's mode with
  lchmod, on the link, never on what it points at; a platform that cannot
  set a link's mode (no lchmod) refuses the copy where the new link's mode
  differs, rather than keep a copy that differs from its source.

The rule is that the work is unchanged only if everything its copy would
carry is equal byte for byte, and anything that cannot be compared exactly
counts as changed. Two things bound it, and neither is a claim of byte
equality:

- **The index's derived data, a deliberate semantic exception.** The index
  file also holds a cache of each file's stat data, which a read-only Git
  command rewrites, and extensions derived from its entries. It is compared
  by what it holds (its entries, its resolve-undo records and its mode), not
  by its bytes.
- **The shared repository, a custody boundary.** The repository the worktree
  belongs to stays where it is: its objects, its other branches and the
  settings a clone of it is served under (a shallow boundary, grafts, hidden
  refs) are not compared. That holds because no retire removes that
  repository or deletes a branch, and a commit of the worktree that no ref
  reaches is preserved before the worktree is removed.

**How the retire runs Git.** Every Git command the retire runs on the work,
its repository, a repository under the work and a recovery clone is run
from argv, without a shell, with `--no-optional-locks` and
`GIT_OPTIONAL_LOCKS=0`, so a `git status` never refreshes, and so never
rewrites, the index it inspects. It also runs with `-c core.fsmonitor=false`,
`-c core.hooksPath=/dev/null` and `-c diff.external=`, so no fsmonitor, hook
or external diff that the repository's own configuration names runs, and
with `GIT_NO_LAZY_FETCH=1`: an object the repository lacks (a promisor
repository's) is a read that fails, never a fetch through the remote, remote
helper, ssh command or credential helper its configuration names. That
protection needs Git 2.44 or later; an older Git ignores the variable, so it
gets none, and nothing else changes. The
caller's repository-local Git variables are not passed: Git's own list
(`git rev-parse --local-env-vars`: `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_COMMON_DIR`, the object directories, `GIT_CONFIG`,
`GIT_CONFIG_PARAMETERS` and the others), and `GIT_CONFIG_COUNT` with its
`GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` pairs. A read that names
its own index (the index the copy carries) keeps it. The operator's global
and system configuration are still read: the spawn baseline was taken under
them, and without them a status can read differently (a global
`core.excludesFile`, `core.autocrlf`, a filter), which would add a copy
attempt to every existing instance's retire. They are the operator's own;
what the retire guards against is configuration the retired agent could
write.

<a id="retire-filter-drivers"></a>
**Filter drivers of the repository are not run.** Git runs a
`filter.<name>.clean` or `.process` command when a status compares a
work-tree file that carries the `filter` attribute (`.gitattributes`, or
`info/attributes` in the Git directory), and it has no switch that turns
filters off. Before each `git status` of the worktree, of a repository under
it and of a recovery, and before a recovery's `git checkout`, the retire
reads the repository's own configuration (`git config --list`, which runs
nothing and follows `include.path` and `includeIf`) and overrides every
filter driver it defines to no command (`clean`, `smudge`, `process`) and
not required. The status the spawn baseline is taken from is read the same
way.

- A file such a filter applies to is compared as its bytes are in the work
  tree, not as the filter would store them. An untouched file still reads as
  unchanged, by the size and times the index recorded for it. One that was
  rewritten, or whose times Git cannot tell from the index's, reads as
  changed even when its filtered form is what is stored: it is work to
  preserve, the retire copies it, and a worktree holding it is not removed
  as a clean one.
- A driver whose name cannot be passed on Git's command line (it holds `=`
  or is not UTF-8) cannot be overridden. Git is not run, and the status has
  failed: the retire refuses with `E_WORK_INSPECTION_FAILED` at its first
  inspection, as for any [status that fails](#retire-status-fails), with
  `--discard-worktree` and `--force` too. A spawn into a worktree of such a
  repository is refused with the same code before its checkout and rolled
  back ([a checkout runs no filter driver](#checkout-filter-drivers)). Remove
  or rename the driver in the repository's configuration, then retry.
- A driver that the operator's global or system configuration defines is
  the operator's own and runs with the operator's command, in the worktree
  and in the recovery alike. That holds when the repository's configuration
  defines a driver of the same name too (`git lfs install --local` beside
  `git lfs install`): the repository's values for it are replaced by the
  operator's, so a command the repository gives that name never runs. The
  operator's configuration is the human's; the repository's is the agent's
  to write. One case runs neither: the repository defines `process` for that
  name and the operator's configuration does not. Git has no way to unset a
  variable on its command line, and a `process` set to nothing turns the
  driver's `clean` and `smudge` off with it, so the file is read unfiltered.
- The recovery has no local configuration, so it has none of the
  repository's drivers. Its status must still be the worktree's, and for a
  file such a filter applies to it can differ: the worktree reads an
  untouched file as unchanged by the size and times its index recorded,
  while the copy, whose files are written anew, compares its bytes with the
  stored form. The copy then cannot be verified: the retire refuses with
  `E_WORK_PRESERVATION_FAILED` and removes nothing. This is so only for a
  driver the repository alone defines.
- Not covered: a driver written into the configuration between that read
  and the Git command that follows it, and a filter a **submodule's own**
  configuration defines. Git runs inside each populated submodule to learn
  whether it is dirty, and the overrides name the repository's drivers, not
  the submodule's. Where the agent and whoever retires it are one system
  user, which is the usual arrangement, such a filter runs nothing the agent
  could not run itself. Where they are separate users, it runs the agent's
  command as the retiring user: do not retire a worktree with populated
  submodules across users.

**A worktree whose top level is another directory.** A worktree's
per-worktree configuration can set `core.worktree` to a directory other
than `<home>/work`. Git's status then describes that other directory, while
the retire reads, copies and removes `<home>/work`. So before any status is
trusted, in each of its three inspections, the retire checks that Git's top
level for `work/` (`git rev-parse --show-toplevel`) is `<home>/work`. The
two are compared in their on-disk spelling: a path reached through a
symbolic link, or spelled in another letter case on a case-insensitive
filesystem, is the same path. Any other top level, or one that cannot be
read, refuses with `E_WORK_INSPECTION_FAILED`, naming both paths. The first
inspection runs before the session is stopped and before any retire hook:
nothing was stopped, run or removed. At the inspection before the hooks the
refusal says that no retire hook has run and nothing was deleted, and
whether the session has been stopped. After the hooks it says that they
have run, that the home, its work and the pre-hook recovery (if any) are
kept, and whether the session has been stopped.

The permission bits of the home directory and of the worktree directory
themselves are not compared: their copies are made in directories the copier
creates, which do not carry them.

Every part of that state is compared as its bytes, never as decoded text. A
ref name, a path in the index or in the status, a file name or the target of
a symbolic link need not be valid UTF-8, and two states that differ only in
such bytes are two states. The copier carries names as bytes too: a file of
the home or of the work whose name is not valid UTF-8 is copied under that
name, and the retire goes on. Where a name is shown (a receipt's `paths`, a
message), it is text, with replacement characters for such bytes. One limit
stays: Git is run on a nested repository by its path, and a path that is not
valid UTF-8 cannot be given to it, so a nested repository whose own path holds
such a name refuses the copy with `E_WORK_PRESERVATION_FAILED`, with nothing
removed; rename that directory, then retire again.

A worktree's tags, stash, exclude rules and settings are kept by the
repository it belongs to. They are part of the state because a work copy
carries them, so a tag or a stash made in that repository while the retire
hooks run adds a copy attempt. That repository's other branches are
not part of the state: they outlive the worktree, and a recovery does not
hold them. The one exception is a worktree whose copy is made detached (its
`HEAD` is detached, on a ref that is not a branch, or on a branch whose name
is not UTF-8): its copy holds the branch the `HEAD` of the repository it is
cloned from is on, so that branch is part of the state. When the retire removes the worktree, whether a ref that outlives
it reaches the commit `HEAD` is at is part of the state too: a hook that
deletes the one ref that reached it adds a copy attempt, though the
files, the status and `HEAD` did not move.

**A worktree that holds a repository is not provable.** A directory under
the worktree that holds a `.git` entry of any kind, a dangling symbolic link
included, makes the worktree not provable. One whose `.git` is a directory, a
file or a link that leads to one is a repository: one made by `git init` or
a clone, a submodule, or a linked worktree of another repository placed in
the work. One whose `.git` is a dangling symbolic link, or could not be
tested, is not read as a repository and counts all the same: the copy
carries such a link as a link, and the copy's verification holds it as one. A
repository's
state is not compared:
the retire hooks run between the two copies and can change it in ways no read
of its state covers (its configuration, its objects, what a clone of it is
shown). So the work of such a worktree is in the pre-hook snapshot and is
copied again after the hooks, whatever they did. `afterHooks.work` is then
`true` on a successful completion: it says that a work copy was made after
the hooks, not that a hook changed the work. The copy after the hooks can
fail where the one before did not, because a hook changed the nested
repository; the retire then refuses with `E_WORK_PRESERVATION_FAILED` after
the hooks, and the home, the work and the recovery written before the hooks
are kept.

A worktree with a `.git` entry under it that OATS cannot read as a
repository (a dangling symbolic link, or a `.git` it cannot test) is never
home-only, and no class is added for it. So a change to the home alone can
now cause a work-copy attempt before the hooks that OATS 0.41 did not make,
and any failure of that attempt can refuse the retirement: it refuses with
`E_WORK_PRESERVATION_FAILED` before any retire hook runs, with no recovery
written and the home and the work kept. What the retire did before the copy
stays done, and the refusal says so: a launched instance's session has been
stopped by then.

Copied again is not "nothing is lost": a nested repository with its own Git
directory is removed with the worktree, and its copy is a clone. What the copy of a nested repository
holds of each kind:

| Of the nested repository | The copy holds |
|---|---|
| `HEAD` | on the same branch, or detached at the same commit when the source's is detached (or on a ref that is not a branch, or on a branch whose name is not UTF-8); on the same branch with no commit when the source's has none ([below](#nested-no-commit)) |
| every local branch | the branch under its name, at its commit |
| the reflogs of `HEAD` and of each branch | branch and `HEAD` reflogs are carried, with every commit they name |
| tags | the tags and what they name |
| the stash | every entry the stash's log names, and the log |
| the index | the index, with every blob its entries and its resolve-undo records name |
| its local configuration | only the status settings (`core.fileMode`, `core.ignoreCase`, `core.precomposeUnicode`, `core.symlinks`, `core.autocrlf`, `core.eol`); remotes, `branch.*` upstreams, `user.*` and everything else are dropped |
| remote-tracking refs, notes, any other namespace | nothing beyond what a branch, a tag or a log reaches |
| a repository inside it | its files, its Git directory included, as plain files |

The local configuration is dropped on purpose: a recovery must be inert to
inspect. A repository's configuration can name programs Git runs
(`core.hooksPath`, `core.fsmonitor`, `include.path`, a credential helper, a
diff, textconv or filter driver), which would run when an operator later runs
Git in the recovery. Set by hand in the recovery only what you trust.

**Every object the copy's Git metadata names is in it.** For the worktree's
copy and for each nested repository's alike, the copier collects what the
Git metadata it carries names: every commit the stash's log names (the new
id of each entry, as `git log -g refs/stash` shows them), the commit each of
`CHERRY_PICK_HEAD`, `REVERT_HEAD` and `REBASE_HEAD` names, every commit
`MERGE_HEAD` names (one per line), and the tree `AUTO_MERGE` names with the
trees and blobs under it that the copy lacks (a conflict's files are in no
commit), whether the copy took the ref as a file or wrote it, for a nested
repository the commit of each of its local branches (its own `refs/heads`,
including a branch its configuration hides from a clone) and every commit
its `HEAD` and branch reflogs name, and every blob
the copied index's entries and resolve-undo records name (a gitlink names
another repository's commit and is left out). It asks which of them the
copy lacks, fetches the missing commits from the source by id and copies
the missing blobs by content (a staged blob or a resolved conflict's side
can be in no commit), then checks the whole set again. An object the
source cannot supply (a partial clone that lacks it: the retire never
fetches from a promisor remote) refuses the copy with
`E_WORK_PRESERVATION_FAILED`, naming it. An operation's ref that names an
object the source itself lacks is copied as it is and names nothing in the
copy either; where that ref must be written (the reftable format), Git
refuses to write it, and so the copy is refused. So `git stash show
stash@{2}`, `git checkout -m <path>` and `git cherry-pick --continue` work in
the copy as in the source. What the copier
cannot carry at all (an entry that is not a file, a directory or a symbolic
link, or a nested repository whose path is not valid UTF-8) refuses the copy,
here as anywhere.

<a id="copied-as-one-file"></a>
**What the copy takes as one file must be a regular file.** The index,
`info/attributes`, the stash's log and a nested repository's reflogs are each
copied as one file. A link at such a path is followed, as Git follows it: the
recovery holds a plain file with what Git reads through the link. A path
that is not there, or a link that leads nowhere, is left out of the copy, as
Git reads nothing there. Anything else at such a path (a directory, empty or
not, a FIFO, an entry that cannot be read) refuses the copy with
`E_WORK_PRESERVATION_FAILED`, naming the path and what is there. The retire
looks before it copies, so the answer is the same on every file system.

For the index this refusal is not reached. Git reads the index before the
copy takes it, and Git fails where a directory, or a file that is not an
index, stands at it. The retire then refuses with Git's message: for the
instance's own tree at the inspection (`E_WORK_INSPECTION_FAILED`, before
anything is stopped, run or removed), for a nested repository when its state
is read for the copy (`E_WORK_PRESERVATION_FAILED`, the home and the work
kept). An index that cannot be read refuses at the inspection in both,
unless it is a nested repository's and a link leads to it: the retire then
refuses when that repository's state is read, as for a directory there.

<a id="no-index-file"></a>
**A tree with no index file is copied with none.** A work tree made by
`git worktree add --no-checkout`, or one whose index file was removed, has no
index file, and Git reads it as a tree whose index lists nothing: every
committed file is a staged deletion, and every file in the tree is
untracked. A retire copies it as it copies any tree that holds work, and
the recovery's `repo/` then has no index file either: Git reads it as it
read the tree. The same holds for a nested repository that has a commit and
no index file.
`git reset` in the recovery makes an index from `HEAD`: the committed files
are tracked again, and a file that was changed in the tree shows as changed.

<a id="nested-no-commit"></a>
**A nested repository with no commit at its `HEAD` is copied as one.** After
`git init` and no commit, or after `git switch --orphan` in a repository that
has commits, a repository's `HEAD` names a branch nobody has committed on.
The recovery rebuilds it as it rebuilds any nested repository: its `HEAD` is
on the same branch and has no commit, its other branches are there with
their commits and their logs, and its index, what is staged in it and its
files are the source's. One with no index file either (`git init` and
nothing added) has none in the recovery. A `HEAD` with no commit that names
no local branch (a ref outside `refs/heads/`, or a branch whose name is not
UTF-8) is refused with `E_WORK_PRESERVATION_FAILED`, naming the repository,
the home and the work kept: there is no commit to detach the copy at and no
branch to put it on. A commit in that repository, or `git switch -c
<branch>` there, makes the work tree retirable.

**A worktree that cannot be proven unchanged.** Two things make a worktree
not provable:

- a repository under it (above);
- a read of the state that fails, while `git status` works: one of the Git
  commands the list above is read with, or one of the files it is read from
  (`info/attributes`, the stash's log, the index, an exclude file, the
  operation state). A worktree whose path has a line feed in it is such a
  case: Git prints its directories over more than one line. A read that
  fails is never taken for "not set" or for "unchanged", and neither is a
  file or directory that the retire cannot test for (no permission, for
  example): only one that is not there is absent.

A worktree that is not provable always has its work in the pre-hook
snapshot, also when only the home has something to preserve, and the work is
copied again after the hooks whenever there is something to preserve. Its
recovery is therefore larger. With nothing to preserve it retires like any
other. The copy reads what the proof reads, so where the proof failed the
copy may fail too: the retire then refuses with `E_WORK_PRESERVATION_FAILED`
before any retire hook runs. No recovery was written and nothing was
deleted; the retire has already stopped the session of a launched instance
by then, the instance is not retired, and its home and work are kept.

A retire hook can leave the worktree in that state too. The snapshot before
the hooks was then taken of a provable worktree, and may hold the home only.
After the hooks the work is copied under `after-hooks/`, whether or not
anything in it moved. When that copy cannot be made, the retire refuses with
`E_WORK_PRESERVATION_FAILED` after the hooks have run, and the home, the
work and the recovery written before the hooks are all kept.

Every refusal of the copy made before the hooks, whatever its cause, ends by
saying what the retire has done by then: no retire hook has run, no recovery
was written and nothing was deleted, the instance is not retired, its home
and work are kept, and its session has been stopped, or this retire stopped
no session. A refusal of the recovery after the hooks (the copy of what they
moved, or the one recovery of a home that had nothing to preserve before
them) ends the same way: the retire hooks have run; the home, its work and
the pre-hook recovery (if any) are kept; and its session has been stopped, or
this retire stopped no session.

A copy that fails removes what it staged, so the refusal carries the copy's
own cause. The copy gives each directory its source's mode, so a read-only
directory in the work (a Go module cache, for example) is copied read-only;
the cleanup makes every staged directory writable before it removes them, and
never replaces the original error. A staging directory that still cannot be
removed is named in the refusal, to be removed by hand.

A snapshot that holds the home only (the work had nothing to preserve
before the hooks) has no work copy to stand for it. It gets the work under
`after-hooks/` when the hooks moved it, and also when they did not but
something beyond the home is there to preserve after them, such as a
retirement baseline that is gone.

The Git state is read at every inspection. When there is something to
preserve before the hooks, the files are read once before the recovery is
written, and a pre-hook copy of the work is verified against that read. They
are read at most once more after the hooks: to prove the work unchanged when
the Git state did not move, or to verify the copy when it did. With nothing
preserved before the hooks, nothing is compared: a
recovery is written after them whenever there is something to preserve.

Those reads are the inspection's own where they can be: the walk that takes
the untracked and ignored digest of the worktree takes its bytes from the
same read of each file. A directory instance's pre-hook copy is verified by
reading the copy back and comparing it with the bytes the inspection before
the hooks read. A file changed before the copy read it refuses the retire
with `E_WORK_PRESERVATION_FAILED`, before any hook, as does a copy changed
after it was written. A file changed during the copy, after it was copied, is
not in the pre-hook copy: the inspection after the hooks reads the work
again, sees the change, and copies the work again, verified, under
`after-hooks/`. Every other copy of the work is the last read of its source
before the home is removed, and it reads the source again after the copy:
any change since the inspection refuses.

Every digest reads its files itself, one at a time, in a fixed order. While
it reads them, a few worker threads read the files it reads next, so a tree
that is not in the page cache yet (a copy just made on a file system that
clones files, a `node_modules/` not read for a while) comes from the cache.
That changes no digest and no error, and it is bounded: at most four files
are read at once, each through a 1 MiB buffer, and never more than 64 MiB or
4096 files ahead of the digest.

<a id="retire-status-fails"></a>
A worktree whose `git status` fails refuses the retire with
`E_WORK_INSPECTION_FAILED` at the first inspection: no recovery was written,
nothing was deleted, and the retire has not stopped the instance's session.
A directory in place of `info/exclude`, or of the file `core.excludesFile`
names, is such a case: Git itself refuses to use it. So is an untracked or
ignored path that the comparison with a spawn baseline of 0.49.0 or later
cannot read, such as an ignored directory with an entry under it that has
no permission: the message names the path and the reason, and says that
nothing was stopped, run or removed. Any other read of the
state that fails does not refuse here: it makes the worktree not provable,
as described above.

**A socket, a FIFO or a device file in the worktree.** An entry that is not
a file, a directory or a symbolic link has no bytes to read or to copy, and
Git prints no status row for it, so a worktree that holds one can read as
clean. Such an entry refuses the retire, at one of three points:

- **at the first inspection**, when the entry is where that inspection reads:
  inside a directory that Git reports as ignored whole (unless a capability
  declared it a disposable work root), in the `work/` of a directory
  instance, or in the home itself. The code is `E_WORK_INSPECTION_FAILED`.
  The message names the entry and says what to do, and ends there. The first
  inspection runs before the retire stops the session: the session is still
  running, no recovery was written and nothing was deleted;
- **before the hooks**, when the entry is anywhere else in a worktree and
  there is something to preserve, with `E_WORK_INSPECTION_FAILED`: no hook
  has run, no recovery was written and nothing was deleted, however often the
  retire is retried. The message names the entry and says what to do: safely
  stop the process or resource that owns it, or move the entry elsewhere,
  then retry. The entry may be a live endpoint, so deleting it is not the
  advice. The retire has already stopped the session of a launched instance
  by then: the instance's session is stopped, the instance is not retired,
  and its home is kept. The message says so, and says that this retire
  stopped no session when the instance had none to stop. To continue, deal
  with the entry and run `oats retire <instance>` again, or start the session
  again in the same home with `oats session start --home <abs>`. A
  self-retire (`--self`) is completed by its detached completion, which stops
  the session and refuses in the same way; the refusal is recorded beside the
  home, as described [below](#self-retire-not-completed). No hook has run at
  this point, so from OATS 0.53.0 the completion removes the self-retire's
  pending marker: the instance is a stopped instance like any other, and
  both `oats retire <instance>` and `oats session start` continue. Before
  0.53.0 the marker stayed, and only a retire continued. Of the refusals at
  this point, only that of `--self --keep-dir`, which stays in the calling
  process, comes with the session still running;
- **after the hooks**, when a retire hook left the entry behind: the hooks
  have run, and the home, the work and the recovery written before the hooks
  are all kept. The code is `E_WORK_INSPECTION_FAILED` when the Git state is
  as it was, and `E_WORK_PRESERVATION_FAILED` when the hook also moved the
  Git state, because the copy then meets the entry before the files are
  read; that message names the entry too.

A worktree that cannot be proven unchanged is copied without the read, so
there the refusal comes from the copy, as `E_WORK_PRESERVATION_FAILED`.

**A file in the worktree that cannot be read.** The same read refuses a file
it cannot read: one without read permission, or one that ends before the
size it had when it was opened, because it shrank while it was read. A
file of any size is read in pieces of 1 MiB, so a file over 2 GiB is read
like any other. Two kinds of file are read although they are nothing
to preserve: a tracked file that is unchanged, and a file under a work root
that a capability declared disposable (`retirement.disposable.work`). So a
retire that has only the home to preserve refuses for such a file, with
`E_WORK_INSPECTION_FAILED`, before any retire hook runs, with or without
`--force`: no recovery was written and nothing was deleted. As for a socket
or a FIFO refused before the hooks, the retire has already stopped the
session of a launched instance by then, the instance is not retired, and its
home is kept. The message is `could not read the worktree at <work>:
<reason>`. The reason names the file. To continue, make the file readable,
move it out of the worktree, or stop what writes to it, then run
`oats retire <instance>` again. With nothing to
preserve, the files are not read and the retire goes through.

**A home whose `instance.json` cannot be read.** The record is what
identifies a home: its soul, its work mode, its session, its lineage. One
that is there and gives no JSON object (a write cut off, an empty file, a
file kept from the user, a directory or a dangling link in its place, JSON
that is not an object) decides only for that home. `oats status` lists the
home with `unknown` and `E_UNIDENTIFIED_INSTANCE_HOME: <home>/instance.json
cannot be read (<reason>)`, and every other instance is listed, stopped,
started and retired as if that home were not there. The home's own retire
(`--plan` and `--force` included), its stop and its session start are refused
with `E_UNIDENTIFIED_INSTANCE_HOME` before anything is read, stopped, run or
removed. `--force` removes a home that has no `instance.json`; it does not
remove one whose record cannot be read, which may be a whole instance with
work. Restoring the file from a copy makes the home usable again; removing
such a home through OATS is not possible yet. A parent whose record cannot be
read has no recorded children for a stop or a retire: the lineage is read
from records, so its children are listed and act on their own. In the other
direction, such a home is never stopped as anyone's child: stop it, once its
record is restored, on its own. The answers are in
[desktop-cli-api.md](desktop-cli-api.md#unreadable-record).

**An entry of the home that cannot be read, or that is gone when it is
read.** Each inspection walks the home: it lists a directory, then reads each
entry. A file or a directory without permission, and an entry that another
process removed or renamed between the listing and the read, refuse the
retire with `E_WORK_INSPECTION_FAILED` at the inspection that met it. The
message names the entry and the system's reason, and ends with what the
retire had done by then, as the other refusals at that point do: nothing was
stopped, run or removed at the first inspection; no hook has run and nothing
was deleted at the one before the hooks; the hooks have run, and the home, its
work and the pre-hook recovery are kept at the one after them. The home is
kept in each case. Make the entry readable, or let the process that writes in
the home end, then run `oats retire <instance>` again. The answer says the
same as data: [`error.details.reached`](desktop-cli-api.md#retire-reached).

The home is not copied again because the work is, and the work is not copied
again because the home is. The home's comparison after the hooks holds every
entry the home copy carries, as its bytes and permission bits, the kernel's
own records included: `.oats-events.jsonl`, `.oats-stop.json`,
`.oats-stop-receipt.json` and `.oats-stop-receipt.*.json`,
`.oats-restart.json`, `.oats-agents-md.*.previous`, `.claude/settings.json`,
and every field of `instance.json`. A hook that writes one of them has the
home copied again. Those records are left out only of the comparison with the
spawn baseline, which decides whether the home has anything to preserve at
all. When a hook moved only the work, the recovery holds them as of the
pre-hook snapshot. The retire's own events are written to the workspace log
(`<deployment>/.agents/events/`), never to the home's. A home copy is
verified against its source, in the same run, with the digest a spawn
baseline is written with (below), which passes over those records and over
the kernel's own fields of `instance.json`: it is not an exact verification
of the whole home.

**What the spawn baseline compares.** Whether the home, and a worktree's
untracked and ignored files, have anything to preserve is decided against
two digests the spawn baseline stores: one of the home (without `work/`, the
provider-owned entries declared at spawn, the kernel's records above, and
the fields the kernel writes into `instance.json` after spawn, for an
`instance.json` of at most 16 MiB: a larger one is taken as its bytes, so a
baseline that took it without those fields reads the home as changed and
the retire copies the home to the recovery), and one of
the worktree's untracked and ignored paths outside the roots a capability
declared disposable. A spawn by 0.49.0 or later records `digestVersion: 2`
in the baseline, and its digests order entries by the bytes of their names,
so no locale changes them; they hold the length of every name, file and link
target, so two different trees never give the same digest; and they take the
untracked and ignored paths from Git's status as bytes and test each without
following a link, so a file whose name is not valid UTF-8 is read by its own
name, and a symbolic link is compared by its target whether or not that
target exists. A baseline written before 0.49.0 keeps the old digests until
the instance is respawned, and a retire compares it with them exactly as
before. Those order names by the locale, so a retire under another locale
than the spawn's can read an unchanged home as changed, which adds a copy
attempt; they hold no lengths; and they read an untracked or ignored path
that is a dangling symbolic link, or whose name is not valid UTF-8, as
missing whatever it holds, so a change to such a path alone is not
preserved. A baseline whose `digestVersion` this kernel does not know is
compared with nothing: the home and the untracked and ignored files count as
changed.

Each part under `after-hooks/` is whole and verified, not a delta, and it is
verified before the worktree step and before the home is removed.
`after-hooks/` is not a complete picture of the instance after the hooks: its
`home/` exists only when the home's own bytes moved, and a part that is not
there is the one in the pre-hook snapshot. Nothing in
the pre-hook `home/`, `repo/` or `work/` is rewritten. If that copy fails or
cannot be verified, retire refuses with `E_WORK_PRESERVATION_FAILED`, keeps
the home and leaves the pre-hook recovery intact. An instance with nothing to
preserve before the hooks, and something after them, gets its one recovery
then: the hooks' bytes are under `home/`, `repo/` or `work/`, and there is no
`after-hooks/`.

The summary prints the recovery once. The path and the `after-hooks/` line
are how to find both snapshots; each line after the path appears only when
it applies:

```text
Retired dev-1 (agent dev)
Work that was not committed has been preserved: changed instance-home bytes, untracked or ignored worktree bytes
  /w/agents/dev/instances/.oats-retirement/recovery/dev-1-AbC123 (46.2 MiB)
  copied from the home: .oats/ (854.2 KiB), .agents/ (138.0 KiB), notes/ (2.0 KiB), STATE.md (512 B) — 994.7 KiB in total
  copied outputs: scratch/ (1.2 MiB), note.txt (12 B) — 1.2 MiB in total
  not copied: .aw, .oats-aweb (oats.aweb)
  after the retire hooks: home copied again under after-hooks/
```

`recovery.json` records the recovery's `phase`. It is `"before-hooks"` when the
pre-hook snapshot is written, and `"complete"` once the post-hook check has
concluded, together with `afterHooks: { home, work }` when `after-hooks/` was
written. `after-hooks/` counts only when `recovery.json` lists it. A retried
retire, after incomplete cleanup or after a refused or interrupted attempt,
starts over: it writes its own recovery, its receipt names only that one, and
it never reads, amends or deletes an earlier one. A directory that an earlier
attempt left at `before-hooks` is not corrupt: it is a complete, verified
pre-hook snapshot.

Home entries that a capability declared in `retirement.disposable.home`
([capabilities.md](capabilities.md#manifest)) are provider-owned state, not
the instance's work, and are not copied: neither before nor after the hooks.
They stay in the home until the home is removed, retire hooks still see them,
and a home kept for a retry keeps them. The summary lists the ones that
exist under "not copied", by name, with the declaring capability. The
declaration is recorded at spawn: a home spawned before its capability
declared them gains no exclusion from a package update, and is copied whole.

Retire stops the harness through the home's session receipt, kept beside the
home in the instances directory's `.oats-retirement/baselines/` and keyed by
the home's path as it is on disk: on a case-insensitive filesystem (the macOS
default) every letter-case spelling of the path finds it. First address the
home exactly as `oats status` prints it: a deployment directory moved since the
spawn looks for the receipt elsewhere. So does a letter-case spelling other
than the spawn's for a home spawned before 0.49.0, whose receipt is keyed by
the spawn's spelling and found from that spelling (or from the on-disk one,
when the two are the same). A home can also be without
its receipt because it was spawned before 0.25.9, it was copied, the
`.oats-retirement` beside it was removed, or its creation did not finish;
`session inspect`, `start` and `restart` then refuse with
`E_RUNTIME_ENDPOINT_UNKNOWN` naming the receipt path they looked for. Such a
home retires only when its session is observably gone:
instance.json records no launch, or the recorded tmux server is not running,
or the recorded window is gone and no pane on that server works in the home;
and, always, no live process on this host works in the home (a harness
started by hand elsewhere counts). Retire then runs its hooks and preserves
its work as usual. If the recorded window is still there, a pane or a process
works in the home (the refusal names its pid), or the
[process scan](#the-process-scan) cannot run, retire refuses with
`E_RUNTIME_ENDPOINT_UNKNOWN`, even with `--force`: stop that session yourself,
then retire again. `oats retire <instance> --plan` says which case applies.

With a receipt, if the recorded window is still running, or its tmux server
cannot be read, retire refuses with `E_RUNTIME_QUIESCE_FAILED` and keeps the
home. When the recorded server cannot be reached because its socket file is
missing (after a reboot), retire proceeds only when no process on this host
works in the home (any process whose working directory is in the home, not
only the harness); a tmux server that lost its socket file still runs, and
recreates the socket when its process is sent `SIGUSR1`. A
[process scan](#the-process-scan) that cannot run or does not complete (a
timeout, for example) refuses the same way, also for a home without its
receipt. Status, start and stop apply the same rule to a missing socket file
([Sessions](execution-targets.md#missing-socket)).

<a id="the-process-scan"></a>
**The process scan.** "No process works in the home" comes from one scan of
the host's processes and their working directories. On Linux it reads
`/proc` (each process's `cwd` link, `comm` and `stat`); elsewhere (macOS) it
runs `lsof`. A Linux host whose `/proc/self/cwd` cannot be read uses `lsof`
too. On a host with neither, `oats doctor` says so in a
`process-scan-unavailable` information line, and retire refuses where it must
rule out a live process (a home without its session receipt, a missing
recorded tmux socket, a Herdr home), as do session start and stop when a
recorded tmux socket is missing: install `lsof`. The scan sees only the
processes this user may inspect: a process of another user, or a
non-dumpable one of the same user (such as `ssh-agent`), is not seen by
either mechanism, so one of those working in the home does not stop a
retire. Refusing whenever such a process exists would refuse on every host
(root daemons, `ssh-agent`). The harness OATS launches runs as the user and
can be inspected, and it is the process the scan exists to find.

`oats retire <instance> --self` lets an instance retire itself when the human
or briefing says it is done. A live harness cannot give a stable final
inspection of its own work, so the calling process inspects, runs, and removes
nothing: it records the intent beside its home as
`.oats-retire-pending-<instance>.json`, which names the completion process, and starts a detached completion, then returns so the instance can report final
status before its tmux window dies a few seconds later. The completion then
retires the instance exactly as an external `oats retire` would: quiesce the
harness, preserve uncommitted work, run retire hooks, repair lineage, remove
the worktree and the home. Success leaves nothing behind: the home and the
marker are gone.

<a id="self-retire-not-completed"></a>A completion that does not complete,
because the retire was refused or failed part way, answers nobody. It
leaves what happened on disk (OATS 0.53.0):

- **Its outcome, always.** `.oats-retired-<instance>.json` beside the home
  holds `ok: false`, the code and the sentence the retire answered, and
  `retry`, the command that retries it. Its log is
  `.oats-retired-<instance>.log`. `oats status` and the Desktop show the
  outcome as a failed deferred retirement until a retire of the instance
  completes. No other command clears it: to drop it without retiring the
  instance, remove those two files by hand.
- **Its pending marker, only when the home is owed a retire:** when a retire
  hook was started or the removal of the home began. The usual quarantine
  marker is there too when hooks reported incomplete cleanup. The instance
  then reads as retiring: `oats instance stop --apply` and `oats session
  start` answer `E_INSTANCE_RETIRING`, and `oats retire <instance>`
  continues. In every other case the completion removes its marker.
  Nothing of the home was changed, so the instance is a stopped or a
  running instance like any other: a start works, and a wake schedule may
  start it. A session or a child that the completion stopped on its way
  does not keep the marker.
- **One event,** `retire-refused`, which says which of the two it was
  ([Events](desktop-cli-api.md#retire-refused-event)).

<a id="self-retire-interrupted"></a>**A completion that was killed** (a
`SIGKILL`, a container that stopped, a reboot) leaves no outcome, and its
pending marker stays. The marker names the completion by its pid, its start
and its boot, and the rule is: a pending marker holds its home only while
the completion it names can still act; once that completion is gone,
`oats retire <instance>` takes the retire over and completes it, and
`oats session start` is refused with that command in its message. A
completion is gone when its process has ended, when its pid runs with
another start, and when the marker was written in another boot, whatever
its pid reads as there. `oats status` shows the row's `retire` as
`interrupted`, and `oats doctor` lists the home. A start answers
`E_INSTANCE_RETIRING`, `<instance> is owed a retire (its retire was
interrupted): finish it with` and the retire to run, because the home is
never started again: the completion may have run retire hooks before it
was killed, and a start would bring back an instance whose identity is
gone. A marker that names no completion (one an OATS before 0.51.0 wrote)
is refused by a start as before, and `oats retire <instance>` completes it.

<a id="self-retire-hook-retry"></a>**A completion retries a cleanup that only
retire hooks left incomplete** (oats-project/oats#1747), because a provider's
failure is often transient. When the retire ends with the home quarantined,
and what it owes is retire hooks and nothing else, the completion runs the
same retire again: up to three times, about 1, 5 and 15 minutes after each
failed attempt. Every attempt is an ordinary retire of the home, under its
claim. Its quarantine retry clears only once the owed hooks are shown to have
run.

- **A retry whose hooks pass ends as a first success does.** The home is
  removed and nothing is left beside it.
- **After the last failed attempt** the completion leaves what it leaves
  today: the outcome, the pending marker, the quarantine and one
  `retire-refused` event. The outcome adds `attempts`, the number of attempts
  that ran.
- **Every attempt has its own `retired` event** with its `hooks` list, so
  `oats instance events <instance>` shows each one and how its hooks ended.
- **What is never retried.** A quarantine that also owes a Git step,
  directory preservation or an orphaned work directory, or whose descriptor
  could not be stored in the home. A capability that declares no retire
  hook, or hooks that cannot be rerun. The retries also stop at an attempt
  that answers an error, and at one whose debt is no longer hooks alone. No
  retry starts once the home is gone or the pending marker is no longer this
  completion's: the retry checks that after its wait and again under the
  home's claim, and leaves a later scheduling's marker as it is.
- **While the completion waits**, `oats status` reads the retire as
  `running`. Any other retire of the home is refused with `E_LIFECYCLE_BUSY`,
  for up to about 21 minutes after a hook failure. The refusal names the next
  attempt and the earliest time the last one starts. The time is only a lower
  bound: how long each attempt runs cannot be known in advance. The completion
  keeps this in a file of its own beside the home,
  `.oats-retire-retry-<instance>.json`, kernel-internal. It is removed on
  every way out, and by any retire that removes the home.
- **A completion killed while it waits** leaves the instance `interrupted`,
  as before.

After that, nothing retries by itself: `oats retire <instance>` does, and
`oats doctor` lists every retirement left open as a `retire-incomplete`
problem, with that command and the capability whose hook failed last
([doctor](desktop-cli-api.md)). A completion removes only the marker of its
own scheduling, so the marker of a later `--self` is left for that one's
completion. Plain retires are not retried: their caller gets the answer.

A completion does not start its retire while its scheduling still holds
the home's claim (OATS 0.53.0). A scheduling that the host holds up
therefore delays the retire and does not fail it. The completion waits for
that one command only, which it knows by the pid and the start time it was
given when it was started: a holder that has died, one whose liveness
cannot be read, and any other holder are not waited for here, and the
retire answers for them as every retire does.

While a completion waits, the instance reads as live in `oats status`
until the scheduling has written its marker, which is the last thing it
does before it releases the claim; from then on it reads `RETIRING`, as
every scheduled self-retire does. Throughout, the scheduling is a retire
that runs, so a stop plan shows `retiring: true`, and a stop apply
(`E_INSTANCE_RETIRING`) and another retire (`E_LIFECYCLE_BUSY`) are refused
with its pid. The wait ends
when that command returns, fails or dies; ending it by hand lets the
completion go on and retire the instance, which is what the instance asked
for. It also ends after ten minutes (`SCHEDULING_WAIT_MS`): the completion
then goes on to its retire, which is refused by the holder that is still
there like any retire, and a scheduling that comes back afterwards answers
`E_SELF_RETIRE_SCHEDULE_FAILED`, having found its completion's outcome.

A `--self` whose completion has already ended when the scheduling writes
its marker answers `E_SELF_RETIRE_SCHEDULE_FAILED`, and nothing is
scheduled: the completion left its outcome, or it is gone and left none
(it was killed, for one). The scheduling removes the marker it wrote, with
the completion's outcome and log if there are any, and the instance is
still live.

**A home that a refused completion left stuck under 0.52.0 or earlier**
still has its marker, and reads as retiring although nothing of it was
changed. To retire it after all, run `oats retire <instance>`. To keep it,
no command does this. Check that the completion the marker names is gone
(its pid is `completionPid` in the marker), then remove by hand
`.oats-retire-pending-<instance>.json`, `.oats-retired-<instance>.json` and
`.oats-retired-<instance>.log` beside the home. The kernel does not do this
for such a home, because it cannot date a refusal that it did not record.

When a retire hook reports incomplete cleanup, the home is quarantined before
any worktree step: the worktree, its git admin entry and the branch stay
exactly as they were, so the retry can reach the hook and the work it needs.
The retry does the worktree step only once nothing else is outstanding:
retain by default, remove with `--discard-worktree`.
`--force` removes the home regardless, so it does the worktree step first. A
work directory whose git admin entry is gone is never removed: the hooks still
run, the home is kept, and `--force` refuses it until you move the directory
out or delete it by hand.

Retire never deletes a branch: not a plain retire, `--discard-worktree`, a
quarantine, its retry or `--force`. `--delete-branch` is refused with
`E_BAD_ARGS` before anything happens. The branch stays in the repository:
inspect it there, and delete it with Git if it is no longer wanted. A spawn
that fails deletes the branch it created only while the branch's tip is
still where the spawn created it. If something was committed there, the
branch is kept and the failure says so; the quarantine's retry stays
incomplete until the branch is deleted with Git.

Before it removes a worktree (`--discard-worktree`, or a failed spawn's
quarantine that owes it), a retire preserves a commit that only the worktree
reaches (HEAD detached at a commit no ref of the repository reaches) in a
recovery, and reads HEAD again immediately before the removal: if HEAD moved
since the retire's last inspection, the worktree is not removed and the
retire stops with `E_WORK_PRESERVATION_FAILED`; the home and the worktree are
kept, and so is any recovery the retire wrote. A worktree whose branch has no
commit yet cannot be read that way: a retire that would remove it, or that
has work of it to copy, refuses with `E_WORK_INSPECTION_FAILED` and removes
nothing.

The `work/` step runs helper-free, as the extra-tree step does (no
fsmonitor, hooks, external diff or lazy fetch that the repository's
configuration names, and none of the caller's Git environment). It names the repository by its
common Git directory, read once from the repository the instance was spawned
from. That covers the default re-home (`git worktree move`), the removal
(`git worktree remove --force` and `git worktree prune`) and a quarantine
retry's checks. A removal is verified: nothing is left at `work/`, and the
repository's `git worktree list` does not name it. A removal that did not
happen, or that cannot be shown to have happened, refuses with
`E_WORK_PRESERVATION_FAILED` and keeps the home, `--force` included. That
includes a removal Git refuses (a locked worktree, for example): such a worktree is no longer deleted with the home, and no
admin entry is left behind. The refusal says what was done: the retire hooks
have run, the home is kept with any recovery the retire wrote, and whether
the session has been stopped. One exception: when nothing is at `work/`
(no entry at all: a dangling symbolic link is an entry) and the repository
cannot be read, the worktree is recorded `absent`, never `removed`. A
quarantine retry then keeps `could not verify removal` as an incomplete
item, which only `--force` clears, as the operator's explicit override.

A plain retire re-homes `work/` (see the extra trees below for where).
Attached children that use this home's `work/` as their own (their
`instance.json` says `work: "attached"` and their `work` is a link to
`<home>/work`, directly or through an alias of it given as `--work-dir`)
would be left with a dangling link. The retire finds them before it moves
the worktree, and repoints a child only if its link is still the one it
found. Each one this retire
stopped as a recorded child is repointed to the retained worktree: a new link
is renamed over the old one, so the link is never missing. This is the last
step before the home is removed, once the worktree is at its new path and
nothing is left at `work/`, and it also runs when the home is then kept for a
retry. A relink that fails is a warning in the summary and the receipt's
`warnings`, with the command to repoint the link by hand; the retire is not
undone. A child that is not attached, whose link leads elsewhere, or that this
retire did not stop is not touched. With `--discard-worktree` the worktree is
removed and an attached child's link then points at a path that is gone: the
summary and the receipt's `warnings` name each such child, the tree and the
link. The retire plan names the attached children in one note that covers
both cases. Only the link changes:
the child's `instance.json` is not rewritten, and its AGENTS.md and TASK.md
still name the old path. A child attached to one of the home's extra trees
is handled the same way, tree by tree
([extra trees at retire](#extra-trees-at-retire)).

#### What `work/` is at retire

The retire and its plan read what is at `<home>/work` once, by one rule
(0.53.0, #962), and the plan says what the retire will do.

- **The instance's own tree.** When the spawn's receipt says the instance
  was given a tree, a real directory at `work/` is that tree. A home without a valid receipt
  goes by its record: `worktree` is the own tree, and a record with no work
  mode (or one the kernel does not know) has it when Git confirms that
  `work/` is a registered linked worktree whose top level it is, by the test
  of an extra tree below. The retire re-homes it, or removes it through Git
  with `--discard-worktree`, after copying what is uncommitted to recovery.
  When the record names no repository, the retire uses the one Git names for
  the tree and does not write it into the record; the plan's note and the
  receipt's `warnings` name it. An own tree for which there is no repository
  at all, recorded or read, is never removed with the home: the retire
  refuses with `E_WORK_PRESERVATION_FAILED` before it stops, runs or removes
  anything, `--force` included, and says to move the directory out or delete
  it by hand.
- **A directory of the home.** A real directory at `work/` that is not the
  instance's own tree: one found where the work mode has a link (an
  attached, a checkout or a workspace instance, or a record with no work
  mode), or under a valid receipt that says no tree was given, whatever the
  record says now. The home's recovery leaves `work/` out, so when the
  directory holds anything the retire copies it to recovery on its own
  (`workRecovery.path/work`, class `directory work bytes`), checks the copy
  against what it inspected, and removes the directory with the home, as it
  does a directory instance's work. Whatever it holds goes into the copy, a
  `.git` directory included.
  It is never read as a tree to move, never removed through Git, and
  `--discard-worktree` and `--force` change none of this. An entry the copy
  cannot take (a FIFO, a socket, a device node) refuses the retire with
  `E_WORK_INSPECTION_FAILED` before anything is stopped, run or removed:
  remove or move that entry, then retire again. When Git confirms that the
  directory is a registered worktree of a repository, its entry stays in
  that repository until a prune; the receipt's `warnings` name the
  repository and give the command (`git -C <repository> worktree prune`).
  Its branch and its commits are not touched.
- **A link** is never the instance's own tree, whatever the record says
  (0.53.0, #973). It goes with the home, and what it leads to is not
  touched: not copied, not moved, not removed, not read through Git, and no
  branch is deleted, with `--discard-worktree` and `--force` as without
  them. The record is a file the instance can write; what a link leads to
  is not the instance's. For a link under a record that says `worktree`
  (the instance's registered worktree moved elsewhere with a link left in
  its place, for example) the plan says so in a note and in its `defaults:`
  line, and the receipt's `warnings` say where the link led: the path the
  system resolved it to just before the home was removed, or that it led
  nowhere that could be read. (The receipt holds the path as it is; the
  retire's text spells a control character or a bidi override in any
  warning as `\u{<hex>}`.) The tree stays registered in its repository.
  A retry of a failed spawn's cleanup over a link verifies no Git debt
  through it: the debt stays outstanding, and `--force` removes the home
  alone. A link that is no longer a link when the retire inspects the home
  again (a retire hook put a directory or a file in its place) refuses the
  retire (`E_WORK_INSPECTION_FAILED`) and keeps the home, since removing
  the home would take what replaced the link, uncopied. The message says
  what is there now and how it ends. For a directory it points to the
  retire plan and says to run the retire again, which reads the home as it
  is then, by its record as it is then and the spawn's receipt: a directory
  that is a directory of the home (the first case above) is copied to
  recovery and removed with the home; a directory under a `worktree` record
  and a worktree's receipt is kept with the home until a person moves it
  out. For a file, or an entry that is neither a link, a directory nor a
  file, it says that no retire removes it and to move it out of the home or
  remove it, then run the retire again; it does not point to the plan. The
  next retires keep such an entry with the home and say so each time (under
  a `worktree` record after the retire hooks have run again, under an
  `attached`, `checkout` or `workspace` record before anything runs). For
  an entry that cannot be read it says that the retire reads it again when
  it is run again. [The retire plan](desktop-cli-api.md#retire) has each
  case.
- **A directory instance's `work/`** is held against the spawn's receipt as
  before: a record that says `directory` where the receipt does not, or the
  other way round, refuses the retire.

Before 0.53.0 a real directory in the second case was read as a worktree.
Most retires of such a home were refused, and one shape was not: under a
record that named no repository, the directory was removed with the home
and nothing of it was copied.

#### Extra trees at retire

An instance can hold [extra trees](#extra-trees) in its home beside `work/`.
Retire handles them itself, so the home removal never deletes their work.

An **extra tree** is a top-level entry of the home named `.work-*` that is a
real directory (not a symbolic link), whose `.git` is a regular file, and that
Git confirms is a registered linked worktree of some repository: its Git
directory differs from its common directory, its top level is the entry
itself, and that repository's `git worktree list` names it. Its repository is
the first entry of that list (the main worktree, or the bare repository).
Anything named `.work-*` that does not verify (a plain directory, an orphaned
`.git` file, a symbolic link, a nested full clone), or that is a worktree of a
repository inside the home itself, is ordinary home bytes, and the home's
recovery copies it as before (with that repository). This holds in every work mode,
`directory` included.

A verified extra tree is not part of the home's recovery bytes: it does not
count as changed instance-home bytes, it is not copied, and the recovery's
`notCopied` lists it as `{scope: "home", path: ".work-<purpose>", owner:
"kernel:extra-worktree"}`.

The extra-tree step runs only when the home is going to be removed: not with
`--keep-dir`, and not when the retire keeps the home for a retry. That is the
condition of the `work/` worktree step (nothing outstanding, or `--force`).
It runs after the retire hooks and before the `work/` step, so a refusal
leaves `work/` untouched. For each tree:

- **A clean tree is removed.** Clean means that `git status`, ignored and
  untracked files included, is empty; no Git operation is in progress
  ([what counts](#git-operation-in-progress)); and its HEAD commit is
  reached by a ref of its repository (the tree's own HEAD, reflog and
  `refs/worktree/` refs do not count: they go with its admin entry). The retire runs `git worktree remove` (without
  `--force`) and `git worktree prune`, and verifies that the tree is gone from
  `git worktree list`. Every Git command of this step runs helper-free (no
  fsmonitor, hooks, external diff or lazy fetch the repository's configuration names),
  as the `work/` step's do. Its branch is never deleted: a commit on the branch that
  was not pushed stays in the clone, on that branch.
- **Any other tree is re-homed**, as `work/` is by default: `git worktree
  move` to `<deployment>/.agents/worktrees/<repo>/<leaf>`, where `<leaf>` is
  the branch name with characters outside `A-Za-z0-9._-` replaced by `-`, or
  `detached-<12 hex>` when HEAD is detached. A target that exists gets `-2`,
  `-3`, and so on. A tree whose HEAD cannot be read is re-homed too.
  `work/` is re-homed under the same rule.

  The leaf is one path component, so it is bounded: at most 231 bytes before
  its `-N` (NAME_MAX, 255, less a 16-byte margin and 8 bytes kept for `-N`;
  the leaf is ASCII, so bytes are characters). A leaf that fits is the
  flattened branch as it is. A longer one, from a long branch, is cut to 224
  bytes, its trailing `-` trimmed, and followed by `-` and the first 6 hex of
  the SHA-256 of the full branch name, so two branches that share a long
  prefix get different leaves. The plan's `movedTo` is the same name.
- **A tree the retire cannot handle refuses it.** A locked tree (`git worktree
  lock`) refuses before anything runs: a retire that would remove the home
  finds the lock in its first inspection, before the session is stopped and
  before any retire hook, and stops with "nothing was run or removed". A lock
  that appears while the hooks run is refused at the step, before any tree is
  touched. A move or a removal that Git refuses (a tree with submodules, for
  example), or a removal that cannot be verified, refuses at the step, after
  the hooks. Each refusal is `E_WORK_PRESERVATION_FAILED` naming the tree,
  and the home is kept. At the step, trees already handled in that pass stay
  handled, and the message says what was done. `--force` does not bypass it:
  it forces past hook cleanup, not past local work.

An instance can be attached to an extra tree as it can to `work/`
([`attached`](#attached--another-instances-tree)). The retire finds the
attached children of every tree before it moves or removes any of them, among
the recorded children it stopped and by the test it uses for `work/`:

- **Where the tree is re-homed**, each one's `work` link is repointed to the
  tree's new path, under the conditions `work/` has (the tree is seen at its
  new path, nothing is left at the old one, and the child's link is still the
  one that was found) and with the same warnings when it cannot be done. It
  is done right after that tree's move, not at the end of the retire: a later
  step can still refuse and keep the home, and the tree has left it either
  way.
- **Where a clean tree is removed**, it is removed as any other, and the
  child's link then points at a path that is gone. The receipt's `warnings`
  and the summary name each such child, the tree and the link.

The plan's note for a tree names its attached children and says which of the
two the retire would do. A retire that refuses after it has handled trees
says, with the trees it handled, each warning it has about their attached
children.

All of this is about the recorded children, for `work/` too. An attached
instance that the plan lists under `ambiguous` (it records this instance as
its parent under a name that is not unique) is not asked to stop, so the
retire does not repoint its link, which then points at the path the tree
has left. The retire says so. The plan's note for an extra tree names such
instances in a clause of its own, and `work/` has a note of its own for
them. The receipt's `warnings` name each one for every tree the retire moved
or removed, with the command to repoint its link by hand where the tree was
re-homed. The receipt of a `--self` retirement does not carry those
warnings; its plan's notes are the same.

`--discard-worktree` applies to `work/` only: a tree that is not clean is
always re-homed. The retire writes one workspace event per handled tree
(`worktree-removed` or `worktree-retained`, with `extra: true` and the tree's
`path`), and its summary prints one line per tree: removed, or re-homed to
the new path.

`oats retire <instance> --plan` lists the trees and what the retire would do
with each, and they are part of the plan's revision: a tree created, removed,
dirtied or cleaned between the plan and a guarded apply, or a new target for
it, refuses the apply with `E_PLAN_STALE` before anything runs. The retire
checks the trees again at the step itself and refuses with
`E_WORK_PRESERVATION_FAILED`, keeping the home, rather than move or remove a
tree in a way the plan did not say. The retire hooks have run by then, and
no tree was moved or removed; that is why the code is not `E_PLAN_STALE`,
which says that nothing happened (it was, before OATS 0.52.0). The fields are in
[the CLI API](desktop-cli-api.md#retire).

<a id="git-operation-in-progress"></a>
**What counts as a Git operation in progress.** The retire reads what `git
status` reads, in the tree's own Git directory: a rebase or a `git am`
(`rebase-merge`, `rebase-apply`), a merge (`MERGE_HEAD`), a cherry-pick or a
revert (`CHERRY_PICK_HEAD`, `REVERT_HEAD`, or a `sequencer/todo` between two
commits of several) and a bisect (`BISECT_LOG`). What an operation leaves
behind when it has ended does not count: `REBASE_HEAD` after a rebase that
stopped on a conflict and was continued, `AUTO_MERGE` and `MERGE_MSG` after a
cherry-pick or a revert, `BISECT_START` and `BISECT_NAMES` without a
`BISECT_LOG`, a `sequencer` directory without a `todo`. A tree that holds
only such files is clean. The retire does not remove them: they are Git's.

The check keeps work, so it errs towards "in progress": an entry counts when
it is there, whatever it is, and one that cannot be looked at (no permission,
for example) counts too. In a repository that stores its refs in the reftable
format, `CHERRY_PICK_HEAD` and `REVERT_HEAD` are not files; there, and only
there, the retire asks Git for the two (`git rev-parse -q --verify`, in the
tree), and any answer but Git's plain "not there" counts: a failure, a
timeout, no Git.

The same answer decides two more things. An instance's own worktree with no
change of its own, in a home that changed, gets a recovery of the home only
unless an operation is in progress in it; then the recovery holds the
worktree too, with the operation's state. And `oats doctor` says `an
operation in progress` of a retained worktree by it.

#### After a retire: inspect, restore, dispose

A retire can leave two things behind outside the removed home: a recovery
copy and a retained worktree. Nothing in OATS removes either; each stays
until you remove it. What follows are facts to decide with, not a judgement
that anything is safe to delete. The uncommitted and untracked bytes in a
recovery are in no commit: a retained worktree or the source may still hold
them, or the recovery may be the only copy, so inspect them before you
remove it.

`oats doctor` lists them all. It prints one `retained-recovery:` line per
recovery copy in each instances directory of the deployment, and one
`retained-worktree:` line per retained worktree. Each kind starts with a line
that gives its total. At most 50 items follow, then `… and N more`. The lines
are also in `oats doctor --json`, in `information[]`. They are read-only: doctor
runs Git without helpers or optional locks, refreshes no index and follows no
link. A fact doctor can't read is said on its line.

- A recovery line gives the path, the instance, `phase` and `classes` from
  `recovery.json`, the size, and whether `after-hooks/` is there. A recovery
  whose `recovery.json` is missing or unreadable is listed and says so, with
  the instance taken from the directory's name. A dot-named entry is the
  staging of a copy that a retire could not remove (`unfinished copy`).
- A retained worktree line gives the path, the repository, the branch (or
  `detached at <commit>`), and `clean` or `not clean; uncommitted: <classes>`
  (staged or unstaged changes, conflicts, untracked or ignored files, an
  operation in progress, [as a retire reads it](#git-operation-in-progress)).
  Doctor doesn't ask Git for the status of a
  repository whose configuration names a content filter (`filter.<driver>.clean`
  or `.process`), because the status would run it: the line says `clean:
  unknown` and names the filter. The status never enters a submodule: it
  compares only the commit each one is at. A tree with a submodule is then
  `clean: unknown (submodule work trees not read)`, or `not clean` when the
  rest of it is, with `submodule work trees not read` after it. An entry that isn't a registered worktree is listed and
  says why.
- Both end with the reachability fact for the HEAD commit. It is checked in the
  source repository against every ref but the tree's own branch:
  `commits: all reachable from <ref>`, `commits: <n> not reachable from any
  other ref`, `commits: HEAD <commit> is not in the source repository`, or
  `commits: unknown (<why>)`. For a recovery, the HEAD is that of its `repo/`
  clone, and the source repository is the one its copied home's
  `instance.json` records. That path is only a hint: it is used only when it
  is a Git repository's top level. A recovery with no `repo/` says `commits:
  no repository copy`. When a retained worktree of the same repository is on
  the recovery's branch, the recovery line names it: the uncommitted bytes
  may be in both.

**Recovery copies** are at
`<instances>/.oats-retirement/recovery/<instance>-<random>/`, beside the
homes of the agent the instance belonged to. The retire summary prints the
path, the receipt names it as `workRecovery.path`, and the `retired` event
in the workspace log keeps it as `data.workRecovery`, so `oats instance
events <instance>` still shows it after the home is gone. Its
`recovery.json` says what it holds:

- `phase`: `"complete"` once the check after the retire hooks concluded;
  `"before-hooks"` when the retire stopped before that, which still leaves a
  complete, verified snapshot of the state before the hooks.
- `classes`: what was preserved (`changed instance-home bytes`, `untracked
  or ignored worktree bytes`, `directory work bytes`, …).
- `afterHooks`: `{home, work}`, present when the hooks changed something
  and `after-hooks/` holds a second copy of that part.
- `home`, `outputs` and `notCopied`: the home entries copied, the untracked
  or ignored outputs copied, and the declared entries left out.

To inspect one, read `recovery.json`, then the parts. `repo/` is a
standalone clone of a worktree instance's repository with its uncommitted
state in place: `git -C <recovery>/repo status`, `git -C <recovery>/repo
log`, `git -C <recovery>/repo stash list`. `work/` is a directory
instance's work, `home/` the copied home (notes, `STATE.md`, …), and
`after-hooks/` the parts as the retire hooks left them.

To restore from one, take what you need back into the source repository or
wherever it belongs. Commits: fetch the branch from the recovery's clone
under a new name, so that nothing in the source repository is overwritten:
`git -C <source repository> fetch <recovery>/repo <branch>:refs/heads/<new
branch>`. Uncommitted files: copy them back, or commit them in the
recovery's clone first and fetch that branch (the recovery then no longer
holds the state exactly as it was taken). Home files: copy them from
`home/`.

To dispose of one, once its contents are settled elsewhere, remove the
directory by hand. A copy keeps the modes of what it copied, so a read-only
directory from the work is read-only there too: `chmod -R u+w <recovery>`,
then `rm -rf <recovery>`.

**Retained worktrees** are at `<deployment>/.agents/worktrees/<repo>/<leaf>`
(see [extra trees at retire](#extra-trees-at-retire) for the leaf). They are
ordinary linked worktrees of the source repository, with their uncommitted
state intact: `git -C <source repository> worktree list` lists them. Once
the branch is merged or pushed and nothing uncommitted in the tree is still
wanted, `git -C <source repository> worktree remove <path>` removes it; Git
refuses a tree with uncommitted changes unless you pass `--force`. Its
branch stays in the repository either way.

## Work modes

A work mode decides what `./work` points at and what discipline the agent must
follow. Every mode sits inside the same home/work boundary, which the generated
instructions state just before the work-mode block, the two closing the file
after the capability injects (`injects/instance-boundary.md`):

- `<instance-home>` — the gitignored instance directory, `$OATS_INSTANCE_HOME` —
  holds the brain (the composed `AGENTS.md`; there is no soul link), the task, the provenance
  (`instance.json`) and the episodic state (`STATE.md`, `log.md`, `notes/`), and
  is where OATS operational/lifecycle commands — and the commands of whatever
  capabilities are active, `aw` among them when aweb messaging is — are run,
  because they resolve scope from the working directory (`--dir <path>` to
  target another one deliberately).
- `<instance-home>/work` — the repository or workspace view — is where
  repository reading, editing, building, testing, git and commits happen, to the
  extent the mode below permits. In `worktree` and `checkout` mode, the
  instance's [extra trees](#extra-trees) in the home serve the same purpose.
- The home has no soul link: the composed `AGENTS.md` already carries the
  soul's instructions, and `instance.json` `soulDir` records the (read-only,
  per-commit) soul directory every hook and dispatched command receives as
  `OATS_SOUL`. Durable soul edits go through tracked paths under `work/` under
  the applicable review rules. The knowledge harvester proposes changes to the
  external knowledge base, never to soul files or skills.

Agents move between the two as the task needs; the boundary is what each
directory is for, not a place to settle in.

### `worktree` — isolated branch

`work/` is a git worktree on the instance's own branch, by default
`agents/<instance>`. The worktree is created from the member's **clone**, found
as `--repo`, then `oats-local.yaml` `clones:`, then `<deployment>/<member name>`
(`E_CLONE_MISSING` / `E_CLONE_MISMATCH` otherwise — see
[configuration.md](configuration.md)).

`--branch <b>` overrides the branch name; `--base <ref>` overrides its start
point. These options apply to worktree mode.

The branch starts at the commit of the soul's repository that the spawn
observed (the one it resolved the soul at), not at what the clone has checked
out: the clone may be a human's checkout or a shared reference, far behind.
The spawn fetches that commit by id into the clone from the remote that names
the repository, and never moves the clone's own branches, remote-tracking refs
or work tree. A commit that cannot be fetched refuses the spawn
(`E_REMOTE_UNREADABLE`, naming the clone and the commit); it never falls back
to the clone's branch. The fetch never prompts (ssh runs in BatchMode, askpass
is refused). A server that serves only its advertised refs (protocol v0 without
`allowAnySHA1InWant`) refuses a commit its branches have moved past; `--base`
is then the way on. `--base <ref>` names another start point in the clone;
a `--repo` that is not a clone of the soul's repository starts at its `HEAD`.
The spawn result and `instance.json` record the start point as
`base: {ref, oid}`.

<a id="checkout-filter-drivers"></a>
**A checkout runs no filter driver of the repository.** Every Git command
OATS runs that writes a tree's files (the spawn's `git worktree add` here,
and the `git worktree add` and `git switch` of
[`oats worktree add`](#extra-trees)) runs with every filter driver the
repository's own configuration defines overridden to no command, so a
`filter.<name>.smudge` or `.process` command that configuration names is
never run and a file carrying the `filter` attribute is written as its
committed bytes. The read of the configuration, the override and their
limits are [a retire's](#retire-filter-drivers).

- A driver that the operator's global or system configuration defines is
  the operator's own and runs. Git LFS set up with `git lfs install` is one:
  its files are checked out as before. A driver of that name in the
  repository's configuration is replaced by the operator's values.
- A driver only the repository's configuration defines does not run. With
  Git LFS set up by `git lfs install --local` alone, a tree OATS checks out
  holds the pointer files, not their content: run `git lfs install` for the
  operator, or `git lfs pull` in the tree.
- A driver whose name cannot be passed on Git's command line (it holds `=`
  or is not UTF-8) cannot be overridden, so Git is not run: the spawn is
  refused with `E_WORK_INSPECTION_FAILED` and rolled back, and
  `oats worktree add` with `E_GIT_FAILED`, its tree removed.

<a id="no-file-monitor"></a>
**No file monitor.** Every Git command OATS runs that reads or writes a work
tree's files or its index runs with `core.fsmonitor=false`, so a file
monitor command the repository's configuration names is never run: these
checkouts and the fetch of `oats worktree add` between its two,
`oats worktree remove`, a retire and its recovery copy, the status a spawn's
baseline is taken from, the reads of `oats instance git` and
`oats instance diff`, and the check `oats package add|remove` makes that
`oats-workspace.yaml` is tracked in the checkout that holds it. The clone's Git hooks (`post-checkout` among them) are not part of
this: they run in a checkout as they do for the operator's own Git.

After the spawn hooks succeed, the spawn fires the
[`worktree` event](capabilities.md#the-worktree-event) for `work/`: the
`worktree` hook of each capability the soul composes runs once, with `work/`
as its cwd, inside the spawn's transaction. A required one that fails rolls
the spawn back. The spawn result and the `spawned` event carry their receipt
as `worktreeHooks`. A spawn whose capabilities declare no such hook runs no
setup. No other work mode fires the event.

Use this for agents that will edit code or docs independently.

Rules:

- Build, test, and commit from `work/`, on your own branch.
- Never work in a shared checkout (the repo's main checkout, or any clone
  others use): do not edit, commit or switch branches there. A clone is
  touched only through `oats worktree add` and `oats worktree remove`
  ([extra trees](#extra-trees)).
- Everything you change happens in `work/` or in your extra trees.
- Leave your branch and the worktree list clean when your task closes.

### `checkout` — shared current branch

`work/` is a symlink to the repo checkout itself (the member clone, found as for
`worktree`).

Use this for maintainers, coordinators, auditors, or agents working on the
repo's current state.

Rules:

- Stay on the currently checked-out branch.
- Do not switch branches unless explicitly asked.
- No destructive git operations (`reset --hard`, rebase, force-push, checkout
  of another branch) unless the human explicitly asks.
- Work that needs its own branch goes in an [extra tree](#extra-trees), not
  in `work/`.

### `attached` — another instance's tree

`work/` points at **another instance's work tree** — same branch, same
uncommitted state. Spawning attached requires `workDir` (`--work-dir`): a
tree in the owning instance's home, its `<home>/work` or one of its
[extra trees](#extra-trees) (`<home>/.work-<purpose>`). It is a spawn-time
choice (`--work attached`) for service agents such as reviewers.

The kernel derives the owner and the repository from the tree named on the
command line, so the spawn needs no `--repo` and no relation flag (an extra
tree from 0.57.0, #958):

```text
oats spawn <soul> --work attached --work-dir <home>/work
oats spawn <soul> --work attached --work-dir <home>/.work-<purpose>
```

- **The owner** is the instance in whose home the tree is, and the new
  instance is its child. It must be an instance of the deployment the spawn
  runs in, and its name must resolve back to that home from there: a name
  that resolves to another instance is refused, since the parent link would
  be ambiguous. The parent is never read from the caller's environment.
- **An attached instance's repository is the repository of the tree it is
  attached to.** For `<home>/work` that is the repository its owner
  recorded. For an extra tree it is the repository Git names for that tree,
  which can be another member repository than the owner's own
  (`oats worktree add --repo`).
- `--parent <owner>` and `--repo <repository>` given explicitly are
  accepted. A relation that is not "child of the owner" is refused.
- An extra tree is one by the kernel's test of it, the same one a retire
  uses ([extra trees at retire](#extra-trees-at-retire)): a linked worktree
  in the home that Git confirms is registered in a repository outside the
  home. The shape of the path decides nothing. A directory named `.work-x`
  that is not such a tree (a plain directory, a clone of its own, a tree of
  a repository inside the home, a tree whose registration was pruned) is a
  tree of no instance, and so is a path inside an extra tree.
- **A tree of no known instance** (an integration worktree, for example)
  has nothing to derive from: the spawn needs `--parent <instance>` and
  `--repo <repository>`. One refusal (`E_BAD_ARGS`) names every one still
  missing, so one retry is enough.

Attached agents are guests: never switch branches or rewrite history, touch
only what the briefing names, keep commits small and attributable. Retiring
an attached instance never removes the shared tree. When its owner retires
and the tree is re-homed, `work/` or an extra tree, the `work` link of an
instance attached to it is repointed to the tree's new path
([retire](#retire), [extra trees at retire](#extra-trees-at-retire)); its
AGENTS.md and TASK.md still name the old one. When the retire removes the
tree (a clean extra tree, or `work/` with `--discard-worktree`), the link
then points at a path that is gone: the plan says so beforehand and the
receipt's `warnings` afterwards, each naming the instance and the tree. The
owner's `oats worktree remove` does not remove an extra tree while an
instance attached to it is running ([extra trees](#extra-trees)). The packaged
`work-attached` instruction source carries this discipline into each generated instance AGENTS.md.

### `directory` — independent execution

`work/` is a new instance-owned directory, not a Git repo or a link to a source.
Use it explicitly for capability workers that need private execution space
without Git. `repo` (or `--repo`) supplies context only and may be an ordinary
directory; without it, the deployment directory (where `oats-local.yaml` is) is
used. No implicit fallback changes the other modes.

`--work-dir` and `--branch` are rejected. Canonical instructions, skill
composition, provider trust and harness preflight still apply. Retirement preserves nonempty work in verified recovery storage beside the
home (`workRecovery.path/work`) before deleting it, including files created by
hooks; directory work has no disposable-root exemptions. A retire hook's later
change to work is in the same recovery, under
`workRecovery.path/after-hooks/work` (under `workRecovery.path/work` when
nothing needed preserving before the hooks). The work-root cannot be
exchanged for a symlink. Recovery does not replace the worker's delivery protocol.

A start refuses a directory home whose home or `work/` is no longer the
directory the spawn recorded (`directory home was exchanged` or `directory work
was exchanged`), for example when another directory was renamed into its
place. The spawn records each root's device, inode and birth time. A root is
the same directory when its device and inode match. On macOS, which gives a
volume a new device number each time it is mounted (every reboot), an equal
inode is enough, provided the birth time also matches when one was recorded
(a home spawned by a kernel that recorded none is judged by the inode alone).

### `workspace` — cross-repo coordinator

`work/` is a symlink to the **whole deployment**: the directory holding
`oats-local.yaml`, with `agents/` and the member clones that sit beside it, not
a repo (a member cloned elsewhere is reached through `oats-local.yaml`
`clones:`). Every
member repo is read-context; the instance's product is coordination:
routing, analysis, task-writing, messaging, spawning specialists.

Use this for free agents that support cross-repo work but are not tied to
any one repo: coordinators, dispatchers, architects. The soul itself still
lives in (and is committed to) its member repository; where the soul lives and
where it works are decoupled.

Rules:

- Read freely across member repos; **never edit or commit inside them** —
  route changes to the owning repo's agents or the human.
- No git state operations in any member repo.
- Knowledge promotion follows the knowledge capability's own protocol, never
  direct edits through the workspace view.

The instance records no branch: the workspace is not a Git tree.

### Extra trees

An instance in `worktree` or `checkout` mode can create extra trees: linked
Git worktrees in its home, beside `work/`. It does so when the work needs
another branch, or another repository of the deployment (one task that
touches several repositories). The `worktree` and `checkout` briefings teach
it; the `workspace`, `directory` and `attached` briefings do not.

```text
oats worktree add --purpose <p> --branch <b> --base <remote-branch>
                  [--repo <member key|clone path>] [--preview] [--json]
oats worktree remove --purpose <p> [--json]
```

Both run from an instance home: the home `$OATS_INSTANCE_HOME` (or
`$OATS_HOME`) names, else the home that encloses the working directory.
`--dir`, `--home` and `--server` are refused (`E_BAD_ARGS`). The tree is
`<home>/.work-<p>`.

**Arguments.** Each is checked before anything is written; a value that
starts with `-` is refused (`E_BAD_ARGS`), because Git would read it as an
option.

- `--purpose`: a slug, as an instance name (lowercase letters, digits and
  `-`, at most 64 characters).
- `--branch`: a valid branch name that does not exist in the clone
  (`E_BRANCH_EXISTS`, with the remedy `<instance>/<branch>`). It follows the
  repository's own naming rules, else `agents/<instance>-<purpose>`. `add`
  never resets a branch: there is no `-C` or `-B`.
- `--base`: the remote branch the work starts from (the branch itself, to
  rework an existing one).
- `--repo`: the instance's repository by default. A member key is looked up
  as a spawn looks up a clone (`oats-local.yaml` `clones:`, then
  `<deployment>/<member name>`; `E_CLONE_MISSING` when there is none). A name
  that isn't a repository key (`oats`, `awebai/oats`, `oats.git`) names no
  member and is refused as before: `E_CLONE_MISMATCH` when a clone is at its
  convention path or `clones:` names one for it, `E_CLONE_MISSING` when there
  is none. When that clone has a remote of that name (its key is the name or ends
  in `/<name>`), the refusal names the key to pass, `--repo <key>`, and the
  clone's path as the other spelling that works. It never suggests repointing
  the clone. A path (absolute, or starting with `.` or `~`) is used as given.
  It must be a clone, not a linked worktree (`E_CLONE_MISMATCH`), and have an
  `origin` remote (`E_CLONE_MISMATCH`). Not a Git repository:
  `E_CLONE_MISSING`.

**What `add` does.** It writes a record, `<home>/.oats/trees/<p>.json`, in
state `creating`, with its own pid and start time. Then it runs, as argument
vectors with no shell:

```bash
git -C <clone> worktree add --detach <home>/.work-<p>
git -C <home>/.work-<p> fetch --refmap= origin <base>
git -C <home>/.work-<p> switch -c <branch> <the fetched commit>
```

- Neither checkout (`worktree add`, `switch`) runs a filter driver the
  repository's configuration defines: the files are written as their
  committed bytes ([a checkout runs no filter
  driver](#checkout-filter-drivers)).
- The tree starts from the remote's current state, never from a local branch
  of the clone, which may be stale. A fetch that fails is
  `E_REMOTE_UNREADABLE`; a HEAD that is not the fetched commit is
  `E_BASE_UNKNOWN`; any other Git step that fails is `E_GIT_FAILED`, with
  Git's message. Either way the tree is removed.
- Creating it moves none of the clone's refs. The fetch runs inside the new
  linked tree, which has its own `FETCH_HEAD`, and `--refmap=` keeps it from
  updating remote-tracking refs. The clone's `FETCH_HEAD`, branches and work
  tree are not touched, so creation does not race with others who use the
  clone. The fetched objects go to the repository's shared object store.
- Then it fires the [`worktree` event](capabilities.md#the-worktree-event):
  the `worktree` hook of each capability the instance composes, with the
  tree as cwd. Their output goes to stderr and to
  `<home>/.oats/logs/worktree-<p>-<cap>.log`. This may take minutes; an
  instance without such a capability runs no setup.
- Last, it marks the record `ready` (with the base commit and the hooks'
  receipt) and appends a `worktree-added` instance event.

The answer (`--json`: one envelope on stdout) is the receipt: `purpose`,
`path`, `clone`, `remote`, `member`, `branch`, `base`, `baseOid`, `state`,
`hooks` (`[{capability, ok, required, log, exitCode, …}]`), `record`,
`resumed` and `warnings`. `--preview` resolves the clone, path, branch, base
and hooks, and fetches and writes nothing.

**Running it again.**

| Found | Result |
|---|---|
| a `ready` record with the same clone, branch and base | nothing is run; the recorded receipt, `resumed: true` |
| a `ready` record that differs | `E_PLACEMENT_TAKEN`, naming the fields that differ |
| `.work-<p>` with no record (made with raw Git), or a file or symbolic link there | `E_PLACEMENT_TAKEN`; use another purpose, or `git worktree remove` that tree |
| a `creating` record whose process still runs | `E_LIFECYCLE_BUSY` |
| a `creating` record whose process is gone | the interrupted add is rolled back first, then the add runs fresh |

A process is "still running" when its pid runs with the recorded start
time. It counts as gone only when its pid does not run (the operating
system says no such process: `kill -0` fails with ESRCH), or runs with another
start, or is a zombie: it has exited or was killed, and its parent has not
reaped it. When the start cannot be read (for example where `ps` fails), the
process is never taken for gone. `add` and `remove` refuse with
`E_LIFECYCLE_BUSY`, naming the pid and the exact file to remove by hand once
you have checked it: the record `.oats/trees/<p>.json`, or the claim
`.oats/trees/<p>.lock`. The same holds for a hook or git step the killed
command left running: when its leader's start cannot be read, it is not
signalled, nothing is rolled back, and the refusal names its process group
and the way out (`kill -TERM -- -<pgid>` once checked, then retry). An `add` that is interrupted (SIGINT, SIGTERM, SIGHUP) while its hooks
run ends the running hook, rolls back and exits 128 + the signal number
(`E_INTERRUPTED`); one killed outright leaves the `creating` record for the
next `add` or `remove`. A killed `add` can simply be run again. A required
hook that fails removes the tree (`E_REQUIRED_HOOK_FAILED`). It deletes the
branch only when that `add` created it, no worktree has it checked out, and
it still points where `add` created it. Otherwise the branch is kept, and
the answer names it with the reason. Two commands on one purpose never act
at once: each holds the purpose's claim, `.oats/trees/<p>.lock`, while it
reads and changes the record. The claim is not held while the hooks run.
A claim left by a command that was killed is taken over by the next one,
once its holder (pid and start time) is verified gone. Any git step the
killed command left running is ended first, so it cannot finish late on
the new tree. A quarantined
home or one being retired is refused (`E_INSTANCE_RETIRING`): one for which
a self-retire is scheduled, and, from OATS 0.52.0, one whose retire is
running (the add reads the home's claim and takes nothing).

**`remove`** runs `git worktree remove` (without `--force`) and `git worktree
prune` on a tree `add` recorded, then drops the record. It keeps the branch
and fires no hook. Git refuses a tree with uncommitted or untracked work:
that is `E_WORKTREE_DIRTY`, with Git's message, and the record is kept;
commit and push the work, or discard it, then run `remove` again. A purpose
with no record is `E_BAD_ARGS`: remove a tree made another way with
`git worktree remove`. Any other refusal is `E_WORK_PRESERVATION_FAILED`,
and the record is kept. Git can remove its registration and some files before
failing on read-only ignored output (for example, a Go module cache). Once
Git's clean check has passed and its registration is gone, `remove` makes
the remaining files writable and deletes them, without following symlinks
outside the tree. It then prunes, verifies removal and drops the record.

A retry of an unregistered tree whose `.git` file points at a missing gitdir
first compares its surviving files with the recorded branch through a
temporary Git index. Deleted files are allowed; modified files and untracked
files that are not ignored are `E_WORKTREE_DIRTY`, with their paths listed.
Deleted entries are marked skip-worktree in that private index so Git can
still read deleted `.gitignore` files from the branch when checking ignored
output. This never changes the clone's index. Cleanup grants directories
owner read, write and search access, and keeps `.git` until all other entries
are deleted, so a failed deletion can be retried.
An unreadable branch or a failed inspection keeps the tree and record.

`remove` runs no file monitor the repository's configuration names
([no file monitor](#no-file-monitor)), and no filter driver it defines
(`filter.<name>.clean`, `.process`): its own status of the tree, the clean
check inside `git worktree remove` and the comparison of an unregistered
tree's surviving files are each preceded by one read of that configuration,
and every driver it defines is overridden to no command, [as a retire does
it](#retire-filter-drivers). A file such a filter applies to is compared as
its bytes are in the tree, so one that was rewritten is uncommitted work
(`E_WORKTREE_DIRTY`)
even when its filtered form is what the branch stores. A driver whose name
cannot be passed on Git's command line (it holds `=` or is not UTF-8)
refuses the removal with `E_WORK_PRESERVATION_FAILED` before Git is run on
the tree: no files were removed, and the record is kept. The same limits
hold: a driver written between that read and the Git command, and a
submodule's own configuration.
Failures after Git started removing files say that removal may be partial
and name the retry. If Git already removed `.git` too, automatic comparison
is refused: save any work and remove the directory by hand, then run
`oats worktree remove --purpose <p>` again to drop the record. The refusal
names that step.
On a `creating` record whose process is gone, `remove`
completes the rollback instead. Its answer then says whether the branch was
kept (`branchKept`, `branchKeptReason`).

`remove` does not remove a tree under a running session. An instance is
attached to the tree when its `instance.json` says `work: "attached"` and its
`work` is a link to it ([`attached`](#attached--another-instances-tree)).
When such an instance's session is running, or cannot be read, `remove`
refuses with `E_CHILDREN_RUNNING` before it asks Git anything: nothing is
removed and the record is kept. The message names each such instance and
what was seen (an unread session is not called running), and gives the step:
stop it (`oats instance stop <instance>`) or retire it, then run `remove`
again. `remove` stops nobody, and no flag removes the tree anyway. An
attached instance whose session is stopped does not refuse: the tree is
removed, and the answer's `warnings` name the instance and its `work` link,
which then points at a path that is gone. The instances looked at are the
recorded children of the tree's owner, as its retire plan lists them, and
those the plan lists as `ambiguous` (they record the owner as their parent
under a name that is not unique): the link makes an instance attached, not
its lineage. A tree that is already gone from disk is not checked.

**Working in the tree.**

- `git switch` needs Git 2.23 or later.
- The tree has no upstream. Push with `git push origin HEAD:<remote-branch>`
  (`<base>` when reworking an existing branch). A push does update the
  clone's `refs/remotes/origin/<remote-branch>`, as any push does.
- Before the task closes, merge each extra tree into the PR branch, or push
  its branch and name it in the hand-back; then `oats worktree remove
  --purpose <p>`.

`$OATS_INSTANCE_HOME` is set in every harness session OATS launches (Claude
Code, Codex, pi), not only in hooks. A tree `add` made is an ordinary extra
tree to retirement, like one made with raw Git: retirement removes a clean
extra tree and re-homes one that holds work, but the briefing tells the agent
not to rely on it: see [extra trees at retire](#extra-trees-at-retire). The
tree records and hook logs under `<home>/.oats/` are kernel receipts: they
never count as changed instance-home bytes at retire.

## Agents root

Instance homes live under the deployment's agents root,
`<deployment>/agents/<soul>/instances/<instance>/`. Commands find the
deployment by walking up to `oats-local.yaml`, so an agent that spawns after
`cd work/` reaches the same agents root as one spawning from the deployment
directory. `PI_AGENTS_ROOT` overrides the root.

Three things stay independent, and are meant to:

- **Invocation**: where you ran the command;
- **Scope**: the deployment, resolved from the context directory, and
  steerable with an explicit `--dir <path>`;
- **`work/`**: the instance's repository view, which may well be a linked
  worktree.

If an agents root sits inside a linked Git worktree, homes land in the
soul-owning repo's primary checkout instead: storage maps to the equivalent
path there, so homes never depend on a disposable worktree. When placement cannot be established (Git owns the
location but the repository cannot be read, the primary checkout is missing,
or the destination falls outside the agent's own directory), the spawn fails
closed with **`E_NO_CANONICAL_ROOT`** and creates nothing.

Every instance is told its own home as **`OATS_INSTANCE_HOME`** (absolute), and
instructions refer to it as `<instance-home>`. The two environments differ, so
they are stated separately:

- **Runtime session**: `OATS_INSTANCE_HOME` and `OATS_INSTANCE`, for every
  harness. The pi extension reads `OATS_INSTANCE_HOME` too; the `PI_AGENT_*`
  names are not set (they stay reserved, so a launch configuration cannot set
  them).
- **Lifecycle hooks**: `OATS_INSTANCE_HOME` and `OATS_HOME`, alongside the rest of
  the hook contract. `OATS_HOME` predates `OATS_INSTANCE_HOME` and is kept because
  shipped capability hooks read it; it is **not** exported to harness sessions.

### Deployment prerequisite: the agents directory must be operator-owned

The canonical deployment (the agents root and the instance homes under it) **must be owned by the operator and not writable by untrusted
users or processes.** OATS validates resolved destinations and re-checks the home
immediately before creating anything in it, but it cannot defeat a concurrent
local attacker who already has write access there: Node offers no
`openat`/`O_NOFOLLOW`-relative directory creation, so a path can in principle be
swapped between the check and the creation. Anyone with that access also
controls souls, generated instructions, hook declarations and instance state, so
this is a deployment prerequisite — filesystem ownership and permissions — not
something the kernel can close from inside.

Default layout:

```text
<deployment>/
  oats-local.yaml
  agents/
    docs-expert/         # a workspace soul, defined in a member repository's
      souls/<commit12>/  #   souls/docs-expert/ and copied here per commit
      instances/
```

Every agent is a soul: a member soul, or a package soul homed under
`agents/<package>--<soul>/`. There are no local souls: author a soul in a
member repository's `souls/<name>` (`soul.yaml` + `AGENTS.md`) and run
`oats sync`.

Homes left by mechanisms earlier releases removed are reported once by
`oats status` and `oats doctor`: `legacy-local-agents` (a `local-agents/`
directory) and `legacy-captured-home`. Retire such instances and re-spawn the
soul from the deployment.
