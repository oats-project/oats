# Sandboxes: boundaries declared in the workspace, started by `oats sync`

**Status:** contracts decided, 2026-11-19. Pepe's side and Juan's side agreed C1–C10
and C3b as written at 0849ef12, with Juan's side's four changes, which Pepe's side
accepted: the registry setting (C3, C6), a keyed `seat` (C4), the receipt of the host's
`remove-member` (C6) and the credential-mount probe (C8). The connector half of C9
stays designed only. Nothing is built yet. A later change to a contract goes back to
both sides (the lane map's "Contract changes" line). When this record and a reference
page disagree after it is built, the reference page wins.

## The goal

One machine runs `oats sync` on a deployment, and the sandboxes that deployment lists
are built and started, with their boundaries declared once in the workspace. The first
use is scheduled knowledge-base ingestor agents on a cloud machine: they read untrusted
content, so they must not reach the engineers' agents, credentials or network.

**Done means:** on a Linux machine with Docker, a workspace that declares one sandbox,
and a deployment whose local file lists it, `oats sync` builds and starts the sandbox.
A workspace schedule whose `runsOn` names that machine spawns its soul inside the
sandbox, with an identity minted on the host. The agent can message only its own team,
reach only the declared destinations and read only the declared credentials. Retiring
it removes its identity from the team. Delisting the sandbox stops it and destroys
nothing. All of this is shown by a live rehearsal and by the tests pinned in each spec.

## Decided with Pepe

- **A team is membership and messaging. A sandbox is the boundary** (its local state,
  credentials and egress). In v1 a team has at most one sandbox, so the two coincide by
  default. They stay separate primitives: a later layout can split one team across
  sandboxes by relaxing validation, with no change to the file format and no identity
  remint (Pepe, 2026-11-19, agreeing to Juan's side's requirement of 2026-11-18).
- **Credentials in v1 are read-only files** mounted into the sandbox. Every agent in it
  can read them, which is acceptable with one team per sandbox (Pepe, 2026-11-19).
- **OATS does not create or delete machines in v1.** Sync builds and starts listed
  sandboxes on a machine that already exists. Creating machines comes later, as a
  provider capability (Pepe, 2026-11-19).
- **Both broker contracts are designed in this effort**: one for secrets, one for
  connectors (Pepe, 2026-11-18). Credential files remain the way to start.
- **Messaging isolation is by server:** each isolated team gets its own aweb server
  with federation outbound off. This needs no aw contract change (Pepe, 2026-11-17).
- **Kept as they are:** the word "team"; the schedule file, with `runsOn` naming the
  machine and no lease; a sandbox does not list its own souls; there is no workspace
  list of shared deployments.

## What exists today, and what this builds on

- `container/agent` is one team's container. It runs every agent, sshd, the wake
  broker and `oats host run` as one user, with its own OATS deployment at
  `/state/deploy`, reached from the host as an OATS server over SSH
  ([container.md](../container.md)).
- Its egress proxy admits fixed base routes (aweb, registry, Secrets, Logs; a declared
  subset since #1955) plus two optional external roles, `source` (`https://github.com`)
  and `model` (`https://api.anthropic.com`). It does not take arbitrary origins
  ([egress README](../../container/agent/egress/README.md)). The Compose boundary probe
  takes a `namePrefix` and reports `--json` receipts (#1958).
- aweb's team bundle, `deploy/team` (`teamctl`, Juan's side), renders one
  `deployment.yaml` into an aweb server, the egress proxy and the agent container. It
  sets `AWEB_FEDERATION_OUTBOUND` to `off` by default. `teamctl start` probes the
  boundary, brings up the agent, and exits 3 on purpose with the agents held: it admits
  no seat.
- Seats: today a container agent takes a retained seat (`identity.source`) that the
  operator provisioned. oats.aweb mints an instance's identity with
  `aw init --join-from <root> --join-team <team>`, which works only where the team key
  is, and at retire it prints `aw id team remove-member` rather than running it.
- The kernel has no Docker code, and must not gain any: provider behaviour belongs in a
  capability.
- `oats-workspace.yaml` and `oats-local.yaml` are closed schemas. An older kernel
  refuses a new root key with `E_WORKSPACE_SCHEMA` and, for the workspace file, an
  "upgrade OATS" hint.
- A `run: spawn` schedule spawns on the host its `runsOn` matches (`host.name`). A
  remote spawn (`--server`) runs preview and apply on the server's kernel, and the home
  lives there.

## The design

### Who does what

| Piece | Owner | Does |
| --- | --- | --- |
| Declaration, validation, placement, CLI verbs, sync | the kernel (lane:product) | Reads `sandboxes:`, refuses the ways round the boundary, decides where a soul runs, calls the sandbox provider, and reports. No Docker. |
| Sandbox provider | a new capability, `oats.aweb-sandbox`, in the oats-aweb package | Turns a sandbox into teamctl input, runs teamctl, registers the sandbox as a server, prepares the in-sandbox deployment, mints and delivers seats, removes members at retire. |
| The team bundle | teamctl, aweb `deploy/team` (Juan's side) | Unchanged, apart from the credential mount (C8). |
| The agent image and Compose | `container/agent` (lane:juan) | A read-only credential mount fragment (C8). |

### Placement

A soul runs in sandbox S when its resolved default team is S's team. Otherwise it runs
on the host, as today. Placement is derived in v1; explicit placement, if it ever comes,
is declared in the workspace and never in a machine's local file.

- On a host that lists S and has it started, a spawn of such a soul (by hand, or by a
  schedule tick) is routed into S, as a remote spawn through S's server registration.
  S1 builds on #1912's floor (lane:juan, held): the task goes on stdin, the apply is
  bound to its preview and keyed, and a host below 0.69.15 is refused. This costs
  nothing, because the sandbox's kernel must already be the release with `sandboxes`.
  S1 may be built now, but does not merge before #1912, whose hold (for the routed-host
  upgrade and a demo) lifts about 2026-11-27 at the earliest. If #1912 is withdrawn, S1 itself requires the same
  three properties of the sandbox's kernel, rather than relying on today's fallbacks.
- On a host that does not list S, the spawn is refused with `E_SANDBOX_NOT_HERE`, naming
  S and the local key that would list it. A sandboxed soul never falls back to the host.
- Inside S, its deployment refuses to spawn any soul not placed in S
  (`E_SANDBOX_PLACEMENT`).

### The clock

There is one clock per machine, and it is the host's. A schedule runs on the host its
`runsOn` names, and its spawn is routed into the sandbox. The in-sandbox deployment
registers no deployment for ticking, so its `oats host run` keeps only the resume sweep
and the ordered stop, and ticks nothing. This replaces the container's clock; it does
not add a second one.

### Identities

Every instance in a sandbox has its own identity, minted on the host at spawn and
removed at retire. The team's controller key and team key stay on the host, under the
operator's account, and never enter the container.

1. Before routing the spawn, the provider mints the instance's identity on the host
   from the host's root for the sandbox team (`roots[T]`), into a private staging
   directory. Where the sandbox team's registry is private, the host deployment sets
   `settings.oats.aweb.registry` for the mint (C3).
2. It delivers only the identity's authority files (the same list retained seats copy
   today) into the sandbox's state, at `/state/seats/<instance>/.aw`, and deletes the
   staging copy.
3. The remote spawn takes that seat as a one-use seat (C6). The agent's own private key
   is then inside the container, which is what aweb's answer requires: there is no
   alternative short of a grant home, and that route is untested.
4. At retire, the routed retire removes the home and releases the seat. The provider
   then runs `aw id team remove-member` on the host, where the controller key is,
   instead of printing it.

A controller key held by the same OS user as host-side agents can be read by those
agents. So a deployment that lists a sandbox runs no host-side agents. A host-placed
spawn there is refused with `E_SANDBOX_HOST_AGENT` (C10).

### Credentials (v1)

The workspace names a sandbox's credentials. The host's local file says where each
value is. The provider mounts each named file read-only at `/run/oats-credentials/<name>`
in that sandbox's agent container only. Nothing else gets a mount, and an undeclared or
missing credential refuses the start. A capability inside the sandbox reads a credential
through its own file setting (for example `settings.oats.okf.github-token-file`), which
the provider writes into the in-sandbox local file from the host's settings for that
sandbox.

### What sync does

After its current steps (the lock, package souls, the automation snapshot), `oats sync`
reconciles each sandbox the local file lists:

- not built, or built from other inputs: build and start it;
- stopped: start it;
- running with the same inputs: nothing.

A sandbox declared in the workspace but not listed locally is never started. A sandbox
listed earlier and now delisted is stopped, never destroyed. `oats sync --plan` shows
these actions and performs none. A failed sandbox does not undo the lock. It is reported
in `problems`, and sync exits nonzero.

teamctl's exit 3 ("agents held") is the expected end of a start. The provider reports
it as `ready`: in this design seats are admitted per spawn, never at start.

### Images

In v1 the agent and egress image digests are host facts in the teamctl deployment file.
teamctl already requires the digest form. The image is not yet published: the release
job is disabled pending the registry decision. Once the release lane publishes it, the
digest moves into the lock with the release. That is a lock format change, proposed
then, not here.

## The contracts to decide

### C1. Workspace `sandboxes:` (new root key)

```yaml
teams:
  ingest-team: { team: "ingest:example.org" }
souls:
  knowledge/knowledge-ingestor: { default: ingest-team }
sandboxes:
  ingest:
    team: ingest-team                       # one sandbox per team in v1
    egress: [model, source]                 # closed set, added to the base routes
    credentials: [sources-read, knowledge-propose]   # names only
    description: Knowledge ingestors         # optional
```

- The name matches `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`. `team` must be a label in
  this file's `teams:`, and no other sandbox may name it (v1).
- `egress` is a subset of `{model, source}`, because those are the external roles the
  egress component supports. Adding another destination is a change to the egress
  component, not a free-form list.
- `credentials` names match `^[a-z0-9][a-z0-9-]{0,62}$`, and are distinct.
- It is closed (`additionalProperties: false`), like every workspace block. An older
  kernel refuses the file with `E_WORKSPACE_SCHEMA` and its existing "upgrade OATS"
  hint, which is the error that tells existing deployments what to do.
- **Adding it breaks every older host of the workspace, not only the sandbox host.**
  Every host reads the shared file, so the first commit that adds `sandboxes:` makes
  each host on an older kernel refuse the whole workspace. A workspace adds the block
  only once every one of its hosts runs the release that has feature `sandboxes`. The
  person who commits it checks that first: the kernel cannot see another person's host.
  The release notes' Upgrade section and the reference page that owns the workspace
  file ([workspaces.md](../workspaces.md)) both say this, and give the check:
  `oats version --json` on each host lists `sandboxes`.
- Feature `sandboxes` in `oats version --json`.

### C2. The three ways round a sandbox are refused (Juan's side's edge cases)

All are refused when the workspace file is read, with `E_WORKSPACE_SCHEMA` and a reason
code:

1. **A sandboxed team as a soul's extra team** (`teams: [ingest-team]`): refused, reason
   `sandboxed-team-not-default`. The `"any"` value means every shared team without a
   sandbox. An explicitly declared bridge is not in v1.
2. **A sandboxed team reached through a wildcard or the default:** a `"*"` or
   `<member>/*` entry whose `default` is a sandboxed team, and a workspace `defaultTeam`
   that is one, are refused (reason `sandboxed-team-by-wildcard`). A sandboxed team is
   reached only through a named soul (`<member>/<soul>`).
3. **A local override:** an `oats-local.yaml` cannot move a sandboxed soul. Local files
   have no soul-to-team mapping today, and a local `defaultTeam` already loses to a
   soul's `souls:` default. A local team may not reuse a sandboxed team's label or
   provider id (reason `sandboxed-team-local`).

### C3. `oats-local.yaml`: `sandboxes` and `credentials` (new root keys)

```yaml
host: { name: cloud-1 }
sandboxes: [ingest]                 # the sandboxes this machine runs
credentials:
  sources-read:      { fromFile: /srv/oats-operator/credentials/sources-read }
  knowledge-propose: { fromFile: /srv/oats-operator/credentials/knowledge-propose }
settings:
  oats.aweb-sandbox:
    sandboxes:
      ingest:
        deployment: /srv/oats-operator/ingest/deployment.yaml   # teamctl host facts
        settings:
          oats.aweb: { registry: https://registry.example.org }   # private registry only
          oats.okf: { github-token-file: /run/oats-credentials/knowledge-propose }
  oats.aweb: { registry: https://registry.example.org }   # the host-side mint (C6)
```

- `sandboxes` lists names that the workspace declares. An unknown name is refused, and so
  is a listed sandbox with no `host.name`.
- `credentials` uses the kernel's existing `fromFile` form. A listed sandbox whose
  declared credential has no source here refuses its start, naming the credential.
- The teamctl file holds infrastructure only (images, network, ports, state directory,
  limits). The provider refuses a file that sets a boundary field the workspace owns
  (`team.id`, `egress.external`, `aweb.federationOutbound`): boundaries are declared
  once.
- **A private registry.** oats.aweb refuses an ambient `AWID_REGISTRY_URL`
  (awebai/oats-aweb#284), so where the sandbox team's registry is private the setting
  is written twice: `settings.oats.aweb.registry` on the host deployment, for the mint
  and for `remove-member` (C6), and the same key in the sandbox's `settings`, which the
  provider writes into the in-sandbox local file. Without the in-sandbox one, the
  in-sandbox spawn refuses with `registry-setting-required`.

### C3b. `oats-local.yaml` inside a sandbox: `sandbox: { self: <name> }` (new root key)

The provider writes it into the in-sandbox deployment's local file. It is a contract of
its own because a kernel reads it:

- `self` must name a sandbox the workspace declares. That deployment then spawns only
  souls placed in that sandbox, and refuses others with `E_SANDBOX_PLACEMENT`.
- It may not be combined with `sandboxes:` (a sandbox runs no sandboxes),
  `credentials:` (credentials reach it as mounts only), local `teams:` or local
  `defaultTeam`. Each combination is refused with `E_WORKSPACE_SCHEMA`, reason
  `sandbox-self-conflict`.
- An older kernel refuses the key as unknown. That is why the agent image's kernel is
  the release that has feature `sandboxes`.

### C4. The kernel–provider hook: `sandbox`

A new capability hook event, `sandbox`. Exactly one active capability may declare it; with
none, any sandbox action is refused with `E_SANDBOX_PROVIDER`. The kernel runs the hook with
`OATS_SANDBOX_ACT` set to `plan`, `start`, `stop`, `status` or `seat`, and one JSON request
on stdin:

```json
{"sandboxApi":1,"act":"start","sandbox":"ingest","host":"cloud-1",
 "team":{"label":"ingest-team","id":"ingest:example.org"},
 "egress":["model","source"],
 "credentials":[{"name":"sources-read","path":"/srv/…"}],
 "workspace":{"url":"…","commit":"…","lock":"<sha256>"},
 "planRevision":"…","idempotencyKey":"…"}
```

The hook prints one JSON answer on stdout:

```json
{"state":"ready|stopped|absent|failed|unknown","server":"sandbox-ingest",
 "receipts":[{"step":"render|probe|start|register|deploy","ok":true,"detail":"…"}],
 "problem":{"code":"…","message":"…","remedy":"…"}}
```

`plan` is read-only. `start` and `stop` carry the plan's revision and an idempotency key,
on the pattern of `oats instance stop`: a stale plan gets `E_PLAN_STALE` with the fresh
plan, and the same key replays its receipt. `seat` mints and delivers one instance's seat
(the Identities section) and answers `{seat:"/state/seats/<instance>/.aw"}`. It too
carries `planRevision` and `idempotencyKey`: a replay of the same key returns the same
seat, or `unknown`, and never mints a second identity. A start whose outcome is
uncertain reports `unknown`, never `ready`.

### C5. CLI and JSON

- `oats sandbox status [--json]`, `oats sandbox start|stop <name> (--plan | --plan-revision <r> --idempotency-key <k>)`.
- `oats sandbox status --json` answers
  `{sandboxApi:1, host, sandboxes:[{name, team:{label,id}, listedHere, state, server, egress, credentials:[{name, source:"present"|"missing"}], problems}]}`.
- `oats sync --json` gains `sandboxes` with the same entries plus `action`
  (`build|start|stop|none`). The field is additive, so `syncApi` stays 1.
- `oats status --json` gains `placement: {sandbox}` on each instance placed in one.
- **That these are additive must be shown, not assumed.** The readers of sync's answer
  are `packages/desktop/server/workspace-sync.mjs`,
  `packages/desktop/renderer/workspace-sync-view.mjs`,
  `packages/client/deployment-data.mjs` and `packages/client/workspace-cli.mjs`. The
  readers of the status answer are the client's roster readers and the warm reader. S1
  lists every reader it finds, with file and line, and pins one test per reader feeding
  it an answer with the new fields. If a reader refuses unknown fields, the change is
  not additive: that answer's API version goes up, and the reader changes first, in its
  own PR.

### C6. oats.aweb settings and behaviour

- `identity.seat` (new): an absolute path to a one-use seat delivered by the host. The
  spawn copies it the way it copies `identity.source`, takes no retained-seat lock, and
  deletes the delivered copy after connecting. It is refused together with
  `identity.source` and with global mode.
- Retire, for an identity minted by the host for a sandbox: the host runs
  `aw id team remove-member` with the controller key it holds, and reports it. It
  removes by the certificate ID that the mint recorded, never by alias. It removes only
  an identity listed in the provider's ledger of seats this host minted for this
  sandbox. An identity it did not mint is never removed, and is reported instead. It
  uses the host's configured registry pin (`settings.oats.aweb.registry`, C3), and
  records its receipt in the retire's meta. A failure, or an outcome it cannot be sure
  of, keeps today's recorded command and warning, and is never retried automatically.
- Between mint and delivery, the instance's private key sits in the host's staging
  directory (0700, under the operator account). `seat` deletes the staging copy on
  every path: success, a failed mint, a failed delivery, a timeout and an interrupted
  hook. The next `seat` or `status` call finds and removes a copy left by a killed hook,
  and reports it. One test per path pins this.
- `oats.aweb-sandbox` (new capability, same package): its settings are
  `sandboxes.<name>.deployment` and `sandboxes.<name>.settings` (C3).

### C7. The sandbox's server registration

The provider registers each started sandbox as server `sandbox-<name>`, using the
existing Docker-context SSH relay from container.md.

- It uses only the fields `servers.json` accepts today (`sshHost`, `workspace`,
  `oatsPath`, `path`), so an older kernel still reads the file. Anything else the
  provider keeps goes in its own state, never in `servers.json`.
- The `sshHost` alias lives in an OpenSSH file the provider owns,
  `~/.oats/sandboxes/ssh_config`, which holds the relay, the per-sandbox operator key
  it generates and the known-hosts file it provisions from the sandbox's host key. The
  operator adds one `Include` of that file to their own SSH configuration once. Readiness
  reports `sandbox-ssh-include-missing` until they have.
- The `sandbox-` prefix is reserved. A new `oats server add|connect` with that prefix is
  refused (`E_SERVER_INVALID`, reason `reserved-prefix`). A `sandbox-*` server that is
  already registered is reported by `oats sandbox status`, not refused: refusing
  configuration that was accepted before would itself be a contract change. The provider
  will not adopt or overwrite it, and that sandbox's start refuses, naming the server.

### C8. teamctl and the container (Juan's side)

- **Credential mount:** a new teamctl input, `agents.credentials`, a map from name to a
  host file. It is rendered as read-only binds at `/run/oats-credentials/<name>` through a
  new `container/agent/compose.agent.credentials.yaml` fragment. teamctl's
  `agents.secrets` stays the harness login only.
- **Probe:** the boundary probe asserts that each credential mount is read-only, that
  it lies only under `/run/oats-credentials`, and that no undeclared credential path is
  mounted. Its receipt joins the probe's `--json` receipts (#1958).
- **Optional, later:** a slimmer profile without Secrets and Logs. v1 runs with
  teamctl's four base routes.
- No other teamctl change is needed. OATS reads its exit codes as they are.

### C9. Broker contracts (designed now, built against the first real provider)

Both follow aweb's three rules. An agent never reads or exports a value. Approval is a
state with a reference, and the same request is resubmitted under the same request ID.
Authority, custody, approval, where execution happens, audit and withholding all stay
with the provider. Inside a sandbox, an agent reaches a broker through the sandbox's
egress routes only.

- **Secrets:** `oats credential list [--json]` shows only the names the caller is
  granted. `oats credential use <name> --action <action> --request-id <id> [--input-file <f>] --json`
  answers `{requestId, state: "done"|"awaiting-approval"|"refused"|"unknown"|"withheld", approvalRef?, result?}`.
  There is no verb that returns a value. A capability implements the contract through a
  `credential-broker` hook with the same request and answer.
- **Connectors:** a sandbox may list `connectors: [<name>]` in C1, a later optional
  key. `oats connector call <name> <operation> --request-id <id> [--input-file <f>] --json`
  takes the same outcome states, through a `connector-broker` hook. aweb has no
  connectors broker built or filed, and whether one is planned is Juan's to say. The
  shape is offered so that a provider-neutral gateway can implement it. It stays
  designed only, and is not built, until Juan says whether aweb plans a connectors
  broker and a provider exists.
- **Order:** both contracts are agreed in this record. Each is built when its first real
  provider ships, and checked against that provider's interface before it is released.
  This keeps Pepe's decision to design both now, and Juan's side's point that a public
  contract must not take its shape from one unshipped product.
- **A change the provider forces is a contract decision.** If checking against the
  first real provider shows the agreed shape must change, the change goes back to both
  sides as a contract decision before it is built. It is never a doc edit.

### C10. Readiness reports; the acts refuse

`oats readiness` reports, and refuses nothing. Its new items are:

- `sandbox-listed-not-running`;
- `sandbox-credential-missing`;
- `sandbox-host-agents`: a deployment that lists a sandbox has host-placed instances;
- `sandbox-provider-missing`;
- `sandbox-ssh-include-missing`.

The refusals belong to the acts:

| Condition | Refused by | Code |
| --- | --- | --- |
| Listed sandbox, no provider | `oats sandbox start`, sync's start, a routed spawn | `E_SANDBOX_PROVIDER` |
| A declared credential with no source, or a missing source file | `oats sandbox start`, sync's start | `E_SANDBOX_CREDENTIAL` |
| A host-placed spawn in a deployment that lists a sandbox | `oats spawn`, a schedule's spawn | `E_SANDBOX_HOST_AGENT` |
| A sandboxed soul on a host that does not list or run its sandbox | `oats spawn`, a schedule's spawn | `E_SANDBOX_NOT_HERE` |
| A soul not placed in this sandbox, inside it | the in-sandbox `oats spawn` | `E_SANDBOX_PLACEMENT` |

**Why `E_SANDBOX_HOST_AGENT`.** The controller key and the credential sources sit under
the account that runs the deployment, because that account mints the seats. A host-side
agent of the same deployment would run as that account and could read them. So in v1, a
deployment that lists a sandbox runs every agent in a sandbox. Agents that belong on the
host run from another deployment, under another OS user. This replaces checking file
modes against users, which cannot be proved from inside one account.

## Left out of v1

- Creating or deleting machines.
- Several sandboxes for one team, and explicit placement.
- A bridge soul between a sandboxed team and another team.
- Human IDs by default and `oats sandbox adopt`. These wait on Juan's own decision on
  reversing "strictly opt-in" (#1665) and on aweb's view. Adoption is specified once
  those are settled.
- Kubernetes. The provider contract (C4) is platform-neutral, and v1's provider is
  Compose through teamctl.
- Publishing the image, and its digest in the lock.

## Alternatives rejected

- **A groups block with its own soul list:** it writes the soul-to-team mapping twice.
- **Sandbox fields inside team entries:** no named container would remain to list, build
  or show.
- **`hostedBy: everyone` for containers:** Docker could start on a laptop that never
  asked for it.
- **A sandbox that lists its own souls and gets an automatic team:** rejected by Pepe.
- **Docker in the kernel:** the kernel stays runtime-neutral; the provider owns
  containers.
- **The container's own clock beside the host's:** two owners of one schedule.
- **Free-form egress origins:** the egress component's guarantee rests on a closed set
  of roles.
- **Credentials through teamctl's `agents.secrets`:** that mount is the harness login
  only, by its own contract.
- **A lease service for schedules:** none exists, and `runsOn` already names one host.

## Delivery

| Spec | Surface | Lane | Builds first |
| --- | --- | --- | --- |
| S1 Kernel: C1, C2, C3, C4's caller, C5, C10, placement and routing | `lib/`, `bin/`, schemas, `docs/` | lane:product | first; built now, merged after #1912's hold lifts |
| S2 Provider: `oats.aweb-sandbox`, C4's hook, C6, C7, the registry setting (C3) | the oats-aweb package | lane:setup, Juan's side reads first | after S1's contract is merged |
| S3 Credential mount: C8 | `container/agent`, and teamctl on Juan's side | lane:juan | in parallel with S1 |
| S4 Broker contracts: C9 docs, then the client verbs | `docs/`, `lib/` | lane:product | after the first real provider |

The live rehearsal runs on a disposable Linux Docker host, never on a person's machine.
It covers every "done means" line, with the egress and boundary probes' receipts kept as
evidence.
