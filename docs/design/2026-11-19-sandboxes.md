# Sandboxes: boundaries declared in the workspace, started by `oats sync`

**Status:** contracts decided, 2026-11-19. Pepe's side and Juan's side agreed C1–C10
and C3b as written at 0849ef12, with Juan's side's four changes, which Pepe's side
accepted: the registry setting (C3, C6), a keyed `seat` (C4), the receipt of the host's
`remove-member` (C6) and the credential-mount probe (C8). The connector half of C9
stays designed only. Nothing is built yet. **Revised after review round 1** (marked
"(r1)" below): existing host homes, lifecycle calls made inside a sandbox, C4's
per-act wire shapes and provider selection, shared team aliases, mount overlap, the
first use's GitHub API route, managed server registrations, and the missing refusal
codes. Both sides decided those, with two precisions from Juan's side, and decided the
`forge` egress role for the GitHub API. **Revised again after review round 2** (marked
"(r2)"): every real agent bind is checked, `status` mutates nothing, the routed
spawn's exact sequence and seat binding, the seat's service descriptor, provider state
scoped per deployment, a team not yet created, and the seat option's key. The r2
additions go back to both sides for their answer on what changed. A later change to a contract goes back to
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
- Its egress component has five base roles (aweb, registry, secrets, logs, signer), of
  which a policy may declare a subset (#1955); teamctl's profile declares four of them
  (all but signer). It adds two optional external roles, `source` (`https://github.com`)
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
2. It delivers the identity's authority files (the same list retained seats copy
   today) and a seat descriptor into the sandbox's state, at
   `/state/seats/<seat-id>/`, and deletes the staging copy. The seat ID is derived from
   the routed spawn's idempotency key, so a seat directory names one spawn, never an
   instance name that can be reused (r2).
3. The remote spawn takes that seat as a one-use seat (C6). The agent's own private key
   is then inside the container, which is what aweb's answer requires: there is no
   alternative short of a grant home, and that route is untested.
4. At retire, the routed retire removes the home and releases the seat. The provider
   then runs `aw id team remove-member` on the host, where the controller key is,
   instead of printing it.

The exact order of a routed spawn, with the revision each step binds (r2):

1. The kernel makes the spawn's idempotency key and asks the provider for a seat plan
   (`plan`, target `seat`, with `instance: {name, soul, spawnKey}`). The plan is
   read-only and answers the seat ID, its path and the `spawnProvider` options.
2. The kernel runs the remote preview **with those options**: the final preview, whose
   resolution revision `R` binds the apply, as #1912 requires. The in-sandbox kernel
   admits a preview that carries a seat option without reading the seat; only an
   apply needs it (Lifecycle, below).
3. The kernel runs `seat` with the plan's revision, `spawnKey` and `R`. The provider
   writes the ledger entry (`minting`, with `spawnKey`, `R` and the seat ID) before it
   mints, mints, delivers, and moves the entry to `delivered`.
4. The kernel runs the remote apply bound to `R`, keyed by `spawnKey`, with the same
   provider options as the preview. No provider input changes between 2 and 4.
5. The kernel passes the apply's own answer to the provider (`bind`, C4). A success
   whose home reports the delivered seat ID and certificate ID moves the entry to
   `active`. A terminal refusal that reports the seat unconsumed releases it (reason
   `spawn-failed`). Anything else leaves it `delivered`.
6. A `delivered` seat is settled only by the keyed replay of the same apply (`spawnKey`,
   `R`), which the provider's `reconcile` act asks for: its success or terminal refusal
   is handled as in 5. Absence of the instance's name, or an unused seat directory, is
   never evidence: the apply may still be running. A seat no replay can settle stays
   `delivered`, and readiness reports `sandbox-seat-unsettled` for the operator.

A controller key held by the same OS user as host-side agents can be read by those
agents. So a deployment that lists a sandbox runs no host-side agents (C10), and this
holds for homes that existed before the sandbox was listed (r1):

- A host-placed spawn there is refused with `E_SANDBOX_HOST_AGENT`.
- Starting, restarting or resuming a host-placed home there is refused the same way,
  by `oats session start` (with or without `--resume`) and by the resume sweep, which
  records the home as `skipped` with that code and the same remedy as session start,
  naming the home, so an operator who reboots after listing a sandbox sees why each
  home did not come back.
- A sandbox's start (by `oats sandbox start` or sync) is refused with
  `E_SANDBOX_HOST_AGENT` while any host-placed home of the deployment is running or its
  session cannot be read. Its remedy names each home: stop or retire it, or move that
  work to another deployment under another OS user. OATS never stops, retires or moves
  existing work itself.

### Lifecycle calls made inside a sandbox (r1)

Minting and removing identities need the host's keys, so in v1 the host is the only
place a sandboxed instance is spawned from, and the host finishes every retire:

- **Spawn inside the sandbox.** The in-sandbox deployment has no root for the team.
  Its kernel accepts a spawn only when it carries a host-delivered seat (the routed
  spawn's `identity.seat`, C4 and C6). Any other spawn there, by an agent or by hand,
  is refused with `E_SANDBOX_PLACEMENT`, reason `spawn-from-host`, whose remedy is to
  spawn from the host. A sandboxed agent that needs a helper asks for one; it cannot
  start one.
- **Retire inside the sandbox** (`oats retire --self`, or a retire run there by hand)
  works as today: the home goes, and oats.aweb prints the `remove-member` command it
  cannot run. The host completes it through the provider's `reconcile` act (C4), which
  `oats sandbox start` and sync run for each listed sandbox, under the sandbox's lock.
  `status` only observes (r2).
- **The sandbox's report is untrusted input.** Reconcile reads the sandbox's instances
  through the server route, and that report comes from inside the boundary. So it can
  only move seats of that sandbox's own ledger toward `released`, and it triggers no
  other act. A seat is released by reconcile only when all of these hold: its entry is
  `active` (never `minting`, `delivered` or `removal-uncertain`), the report lists no
  home holding its seat ID, and its seat directory is gone. The release's receipt
  records that the sandbox's report drove it (reason `reconcile`), so it can be told
  from a retire's removal. A test pins that a report naming a seat of another
  sandbox, or an unknown certificate, changes nothing.
- **Retire from the host** (`oats retire <name> --server sandbox-<name>`, or the
  kernel routing a retire of a sandboxed instance) runs the remote retire, then the
  provider's `release` act (C4) for that seat at once (reason `retired`).
- **The ledger** lives in the provider's state on the host, scoped to the deployment
  (C7): `~/.oats/sandboxes/<deployment-key>/<sandbox>/seats.json`, one entry per seat:
  seat ID, `spawnKey`, `R`, instance, alias, certificate ID, team, state (`minting`,
  `delivered`, `active`, `removing`, `released`, `removal-uncertain`), and the receipt
  of each step. It outlives the remote home, and is the only evidence
  `remove-member` acts on.
- **Removal is written before it runs (r2).** The provider moves an entry to
  `removing`, durably, before it calls `remove-member`, then to `released` or
  `removal-uncertain` with the receipt. An entry found in `removing` was interrupted:
  it becomes `removal-uncertain`, and is never removed again automatically (C6).
- **Compensation.** If the mint succeeds but delivery fails, the provider releases
  the seat at once (reason `spawn-failed`) and deletes any delivered copy. After
  delivery, only step 5 or 6 above settles the seat.

### Credentials (v1)

The workspace names a sandbox's credentials. The host's local file says where each
value is. The provider mounts each named file read-only at `/run/oats-credentials/<name>`
in that sandbox's agent container only. Nothing else gets a mount, and an undeclared or
missing credential refuses the start. A capability inside the sandbox reads a credential
through its own file setting (for example `settings.oats.okf.github-token-file`), which
the provider writes into the in-sandbox local file from the host's settings for that
sandbox.

**No other mount may expose them (r1, r2).** A credential source is a regular file,
read through its real path; a symlink is resolved, and one that leads to anything but
a regular file is refused (`E_SANDBOX_CREDENTIAL`, reason `not-a-file`). The bind
source is the resolved path.

The provider derives a protected inventory, in two parts:

- **Hard-denied:** the host's team roots (`roots`), the seat staging directory, the
  provider's own state (`~/.oats/sandboxes`) and the host deployment directory. No
  bind may equal, contain or lie inside one of these, a declared credential included:
  a credential source inside a team root is refused.
- **Credential sources:** every source in the host's `credentials`, whether a listed
  sandbox declares it or not (an unused one, or one of a delisted sandbox, included),
  and every other sandbox's state, work and mirror directories. Only the exact
  read-only bind of a credential this sandbox declares, at
  `/run/oats-credentials/<name>`, is excepted.

The check runs on **every bind of the real agent container**, before any agent runs
(r2): the provider renders the teamctl deployment and checks each agent bind source in
the rendered configuration (the state, work and mirror directories, the harness login
directory from `agents.secrets`, the authorized-keys file, and the credential binds),
then the container's own mount acceptance checks the started agent's actual mounts
against the same inventory before any seat is admitted (C8). Today's boundary probe
substitutes an empty login directory, so it cannot stand in for this check. A failing
bind refuses the start (`E_SANDBOX_MOUNT`, reason `overlap`, naming both paths), and so
do two sandboxes sharing any such directory. Pinned negative tests: a work or mirror
directory containing an unused credential; one containing a delisted sandbox's
credential; a harness login directory pointing at a team root.

**The first use's GitHub API route: the `forge` role (decided).** `source` admits
`https://github.com` only, and a knowledge proposer also calls `https://api.github.com`
(OKF's own setup check requires both). Both sides decided a third external role for
it:

- `forge` selects exactly `https://api.github.com`, defaults to false and, like the
  other external roles, needs `egress.external.resolvers`. Its wrapper input is
  `egress.external.forge` (teamctl's schema), its policy entry
  `externalTargets.forge.origin`, and the component checks the exact origin again.
- The SNI/Host mismatch refusal applies to it, and the probe tests it: SNI
  `api.github.com` with another Host, the reverse, and `api.github.com` through another
  admitted origin's connection are all refused.
- The external-egress image test and the boundary probe name the hosts that stay
  refused: `uploads.github.com`, `codeload.github.com`, `raw.githubusercontent.com`,
  `objects.githubusercontent.com` and `gist.github.com`.
- **The credential is scoped to one repository, as a requirement.** With a token the
  API can write, and the boundary limits services, not accounts. So the sandbox's
  proposal credential (`knowledge-propose` in C1's example) must be scoped to the one
  knowledge-base repository, as a push credential is today. The egress README's role
  section, this section and the first use's setup steps all say so.
- C1's `egress` set becomes `{model, source, forge}`. `forge` has its own feature,
  `sandbox-egress-forge`, because a kernel that already has `sandboxes` refuses the new
  value through C1's closed set: a workspace uses `forge` only once every one of its
  hosts lists that feature.
- Order: the egress component and teamctl first, on lane:juan (Juan's side launches
  that developer once this record is final); then C1's value, on the kernel side.

### What sync does

After its current steps (the lock, package souls, the automation snapshot), `oats sync`
reconciles each sandbox the local file lists:

- not built, or built from other inputs: build and start it;
- stopped: start it;
- running with the same inputs: nothing.

A sandbox declared in the workspace but not listed locally is never started. A sandbox
listed earlier and now delisted is stopped, never destroyed. The provider keeps the
last declaration it started each sandbox with in its own state, so a sandbox whose
workspace entry was removed together with its local listing is still stopped, from
that record (r1). `oats sync --plan` shows
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

## The contracts (decided)

### C1. Workspace `sandboxes:` (new root key)

```yaml
teams:
  ingest-team: { team: "ingest:example.org" }
souls:
  knowledge/knowledge-ingestor: { default: ingest-team }
sandboxes:
  ingest:
    team: ingest-team                       # one sandbox per team in v1
    egress: [model, source, forge]          # closed set, added to the base routes
    credentials: [sources-read, knowledge-propose]   # names only
    description: Knowledge ingestors         # optional
```

- The name matches `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`. `team` must be a label in
  this file's `teams:`, and no other sandbox may name it (v1).
- `egress` is a subset of `{model, source, forge}` (`forge` behind feature
  `sandbox-egress-forge`), because those are the external roles the egress component
  supports. Adding another destination is a change to the egress
  component, not a free-form list.
- `credentials` names match `^[a-z0-9][a-z0-9-]{0,62}$`, and are distinct.
- **A team not yet created (r2).** A shared team may omit its provider id (declared,
  not created). A sandbox may name such a team: the workspace stays valid, so other
  hosts are not refused. Its start refuses (`E_SANDBOX_TEAM`, reason
  `team-not-created`), and so does a routed spawn, with the existing remedy: its owner
  runs `oats aweb setup`, then commits the id. The id is never inferred from the label
  or an active team. Until it is set, C2's checks compare the label.
- `team` is required. `egress` and `credentials` are optional and default to `[]`;
  `egress` entries are distinct. A duplicate in either list is refused (reason
  `duplicate-entry`) (r1).
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
4. **A shared alias (r1):** two shared labels may today name one provider id. A
   sandboxed team's provider id must be named by exactly one shared label; another
   shared label with that id is refused (reason `sandboxed-team-alias`). Every check
   above, and placement, compare provider ids, never labels alone, so two sandboxes
   cannot name one team through two labels either (reason `sandbox-team-taken`).

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

- `sandboxes` lists distinct names that the workspace declares. An unknown name is
  refused (`E_WORKSPACE_SCHEMA`, reason `sandbox-unknown`), a duplicate likewise
  (`duplicate-entry`), and so is a listed sandbox with no `host.name` (reason
  `sandbox-host-name-required`) (r1).
- `credentials` uses the kernel's existing `fromFile` form. A listed sandbox whose
  declared credential has no source here refuses its start, naming the credential.
- The teamctl file holds infrastructure only (images, network, ports, state directory,
  limits). The provider refuses a file that sets a boundary field the workspace owns
  (`team.id`, `egress.external`, `aweb.federationOutbound`): boundaries are declared
  once. The refusal is `E_SANDBOX_DEPLOYMENT`, reason `boundary-field`, naming the
  field (r1).
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

A new capability hook event, `sandbox`.

**Which capability provides it (r1).** Sandbox acts run at deployment level, with no
soul. The candidates are the capabilities the workspace's `defaults` compose (the
same resolution a spawn uses, without a soul's layer) whose manifest declares the
`sandbox` hook. Exactly one must exist: none refuses any sandbox act with
`E_SANDBOX_PROVIDER`, reason `none`; two or more, reason `ambiguous`, naming them. Its
settings are its manifest defaults, then the workspace defaults, then the host's
`settings.<capability>` in `oats-local.yaml`, merged as for a spawn.

**The call.** The kernel runs the hook with `OATS_SANDBOX_ACT` set to `plan`, `start`,
`stop`, `status`, `seat` or `release`, one JSON request on stdin, and reads one JSON
answer on stdout. The kernel holds a per-sandbox lock around every act but `plan` and
`status`, so two mutating acts on one sandbox never run at once (a second gets
`E_LIFECYCLE_BUSY`). The lock, the plan revisions and the idempotency keys are all
scoped to the deployment and the sandbox (C7's deployment key) (r2). A
hook that exits nonzero, times out or prints anything but one valid answer is read as
`state: "unknown"` with problem `E_SANDBOX_PROVIDER`, reason `hook-failed`.

**Every request** carries:

```json
{"sandboxApi":1,"act":"start","sandbox":"ingest","host":"cloud-1",
 "team":{"label":"ingest-team","id":"ingest:example.org"},
 "egress":["model","source"],
 "credentials":[{"name":"sources-read","path":"/srv/…"}],
 "workspace":{"url":"…","commit":"…","lock":"<sha256>"}}
```

and by act:

| Act | Extra request fields | Answer fields beyond the envelope |
| --- | --- | --- |
| `plan` | `target`: `start`, `stop`, `reconcile`, `seat`, `bind` or `release`; for the seat targets, the `instance` fields of that act | `planRevision`, `actions: [{step, detail}]`; for target `seat` also `seat: {id, path}` and `spawnProvider: {capability, options: {<key>: <value>}}` |
| `start`, `stop`, `reconcile` | `planRevision`, `idempotencyKey` | `server`; for `reconcile`, `seats` as in `status` |
| `status` | none | `server`, `seats: [{seatId, instance, alias, certificateId, state}]` |
| `seat` | `planRevision`, `idempotencyKey`, `instance: {name, soul, spawnKey, resolution}` (`resolution` is `R`, the final remote preview's revision) | `seat: {id, path, alias, certificateId, team}` |
| `bind` | `planRevision`, `idempotencyKey`, `instance: {name, spawnKey}`, `apply`: the routed apply's answer as the kernel received it | `seat: {id, certificateId, state}` |
| `release` | `planRevision`, `idempotencyKey`, `instance: {name, seatId}`, `reason`: `retired` or `spawn-failed` | `seat: {id, certificateId, state}` |

**The envelope** of every answer:

```json
{"sandboxApi":1,"act":"…","state":"ready|stopped|absent|failed|unknown|stale",
 "receipts":[{"step":"render|probe|start|register|deploy|mint|deliver|remove","ok":true,"detail":"…"}],
 "problem":{"code":"…","reason":"…","message":"…","remedy":"…"}}
```

- `plan` and `status` are read-only: they change no state, delete no staging and remove
  no member (r2). Every other act mutates, and runs under the lock.
- `plan` is read-only. Its `planRevision` binds the request's inputs and the
  provider's own state for that sandbox (and, for `seat` and `release`, that
  instance's ledger entry).
- **The provider owns revisions and receipts.** It checks `planRevision` on every
  act that carries one, and answers `state: "stale"` with a fresh plan in `plan`; the
  kernel reports that as `E_PLAN_STALE` with the fresh plan, on the pattern of `oats
  instance stop`. It keeps each `idempotencyKey`'s receipt in its state on the host,
  and the same key replays that receipt and changes nothing.
- `seat` mints and delivers one instance's seat, in the order the Identities section
  gives. A replay of its key returns the same seat, or `unknown`, and never mints a
  second identity. The kernel passes the seat plan's `spawnProvider` to the final
  preview and to the apply alike, as `--provider <capability> <key>=<value>`, one per
  option, so the kernel names no messaging provider. Dotted keys nest, so oats.aweb
  answers `{capability: "oats.aweb", options: {"identity.seat": "<path>"}}`, which sets
  its `identity.seat` (C6) (r2).
- `bind` and `reconcile` settle seats as the Identities and Lifecycle sections say:
  `bind` from the routed apply's own answer, `reconcile` from its keyed replay (for
  `delivered` seats) and from the sandbox's untrusted report (for `active` seats). The
  staging sweep for a killed hook runs in the mutating acts only: under the lock no
  `seat` can be running, so any staging copy found is a leftover.
- An act whose outcome is uncertain answers `unknown`, never `ready`.

### C5. CLI and JSON

- `oats sandbox status [--json]`, `oats sandbox start|stop <name> (--plan | --plan-revision <r> --idempotency-key <k>)`.
- `oats sandbox status --json` answers
  `{sandboxApi:1, host, sandboxes:[{name, team:{label,id}, listedHere, state, server, egress, credentials:[{name, source:"present"|"missing"}], problems}]}`.
- `oats sandbox start|stop <name> --plan --json` answers
  `{sandboxApi:1, sandbox, act, planRevision, actions}`; the apply answers
  `{sandboxApi:1, sandbox, act, state, server, receipts, problems}`, and a stale
  revision refuses `E_PLAN_STALE` with the fresh plan in its detail (r1).
- `oats sync --json` gains `sandboxes` with the same entries plus `action`
  (`build|start|stop|none`). The field is additive, so `syncApi` stays 1.
- `oats status --json` gains `placement: {sandbox, seatId}` on each instance placed in
  one; `seatId` is the seat its home took (r2).
- `oats sandbox status --json`'s entries also carry `seats` (as C4's `status`), and
  `oats sandbox reconcile <name> (--plan | --plan-revision <r> --idempotency-key <k>)`
  runs the `reconcile` act on its own (r2).
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
  `identity.source` and with global mode. A preview reads nothing from it; an apply
  needs it.
- **The seat descriptor (r2).** The retained route reads its service from the
  source's `workspace.yaml`, which is not an authority file. A delivered seat instead
  carries `seat.json`, written by the host at mint:
  `{seatApi:1, seatId, spawnKey, service, team, alias, certificateId}`, where `service`
  is the aweb origin of the sandbox's own server (the egress `aweb` role's origin).
  The spawn reads its service from that descriptor only, never from `OATS_AWEB_URL` or
  a copied coordination workspace, and checks it: `team` equals the team the spawn
  resolved, `alias` equals the instance name, `spawnKey` equals the apply's key, and
  `service` is a plain https origin. A missing, malformed or contradictory descriptor
  refuses the spawn (reason `seat-binding`, naming the field). The host's registry pin
  is a separate setting (C3), never the service.
- Retire, for an identity minted by the host for a sandbox: the host runs
  `aw id team remove-member` with the controller key it holds, and reports it, from
  the routed retire or from reconcile (the Lifecycle section). It
  removes by the certificate ID that the mint recorded, never by alias. It removes only
  an identity listed in the provider's ledger of seats this host minted for this
  sandbox. An identity it did not mint is never removed, and is reported instead. It
  uses the host's configured registry pin (`settings.oats.aweb.registry`, C3), and
  records its receipt in the retire's meta. A failure, or an outcome it cannot be sure
  of, keeps today's recorded command and warning, and is never retried automatically.
- Between mint and delivery, the instance's private key sits in the host's staging
  directory (0700, under the operator account). `seat` deletes the staging copy on
  every path: success, a failed mint, a failed delivery, a timeout and an interrupted
  hook. The next mutating act (C4) finds and removes a copy left by a killed hook, and
  reports it; `status` only reports it (r2). One test per path pins this.
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
  will not adopt or overwrite it, and that sandbox's start refuses, naming the server
  (`E_SANDBOX_SERVER`, reason `server-taken`).
- **Its own registration is not "already registered" (r1).** The provider records
  each registration it made in its state, with the `servers.json` entry it wrote. A
  `sandbox-<name>` server that matches its record is its own: a restart reuses it, and
  stop and delisting keep it and the record, so the sandbox can start again. Only a
  `sandbox-*` server with no matching record counts as taken.
- **Scoped to the deployment (r2).** `servers.json`, the SSH file and the provider's
  state are per OS user, and two deployments of that user may each declare a sandbox
  of the same name. So the provider's state lives under a deployment key, the first 16
  hex digits of the SHA-256 of the host deployment directory's real path:
  `~/.oats/sandboxes/<deployment-key>/<sandbox>/`. The registration record names its
  deployment key. A `sandbox-<name>` server recorded for another deployment key is
  never reused, stopped or overwritten: this deployment's start refuses
  (`E_SANDBOX_SERVER`, reason `server-owned-elsewhere`, naming the other deployment
  directory). The public name stays `sandbox-<name>`.

### C8. teamctl and the container (Juan's side)

- **Credential mount:** a new teamctl input, `agents.credentials`, a map from name to a
  host file. It is rendered as read-only binds at `/run/oats-credentials/<name>` through a
  new `container/agent/compose.agent.credentials.yaml` fragment. teamctl's
  `agents.secrets` stays the harness login only.
- **Probe:** the boundary probe asserts that each credential mount is read-only, that
  it lies only under `/run/oats-credentials`, and that no undeclared credential path is
  mounted. Its receipt joins the probe's `--json` receipts (#1958).
- **Protected sources (r1, r2):** the container's mount acceptance takes the provider's
  `protectedSources` (the two parts of the Credentials section) and, on the started
  agent's actual mounts, asserts that no bind equals, contains or lies inside a
  protected path, the declared credential binds being the only exception to the
  credential-source part. It runs before any seat is admitted.
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
- **What S4's spec settles before it is built (r1),** each a contract both sides
  agree: the `credential list` JSON and its hook request; how the broker capability
  is selected, and the no-provider refusal; how the caller and its grant are bound
  to a request; the scope of a request ID, and what a resubmission with the same ID
  but a different payload gets; and how `result` is kept free of secret values.
  Agreement on this outline is not permission for a provider to choose those.
- **A change the provider forces is a contract decision.** If checking against the
  first real provider shows the agreed shape must change, the change goes back to both
  sides as a contract decision before it is built. It is never a doc edit.

### C10. Readiness reports; the acts refuse

`oats readiness` reports, and refuses nothing. Its new items are:

- `sandbox-listed-not-running`;
- `sandbox-credential-missing`;
- `sandbox-host-agents`: a deployment that lists a sandbox has host-placed instances,
  running or stopped;
- `sandbox-provider-missing`;
- `sandbox-ssh-include-missing`;
- `sandbox-seat-unsettled`: a `delivered` seat no keyed replay could settle (r2).

The refusals belong to the acts:

| Condition | Refused by | Code |
| --- | --- | --- |
| Listed sandbox, no provider | `oats sandbox start`, sync's start, a routed spawn | `E_SANDBOX_PROVIDER` |
| A declared credential with no source, or a missing source file | `oats sandbox start`, sync's start | `E_SANDBOX_CREDENTIAL` |
| A host-placed spawn in a deployment that lists a sandbox | `oats spawn`, a schedule's spawn | `E_SANDBOX_HOST_AGENT` |
| Starting, restarting or resuming a host-placed home there (r1) | `oats session start`, the resume sweep | `E_SANDBOX_HOST_AGENT` |
| A running or unreadable host-placed home when a sandbox starts (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_HOST_AGENT` |
| A spawn inside a sandbox without a host-delivered seat (r1) | the in-sandbox `oats spawn` | `E_SANDBOX_PLACEMENT`, `spawn-from-host` |
| A teamctl file that sets a boundary field (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_DEPLOYMENT`, `boundary-field` |
| A mount that overlaps a protected path, or shared sandbox state (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_MOUNT`, `overlap` |
| A credential source that is not a regular file (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_CREDENTIAL`, `not-a-file` |
| `sandbox-<name>` registered by someone else (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_SERVER`, `server-taken` |
| `sandbox-<name>` owned by another deployment (r2) | `oats sandbox start`, sync's start | `E_SANDBOX_SERVER`, `server-owned-elsewhere` |
| The sandbox's team has no provider id yet (r2) | `oats sandbox start`, sync's start, a routed spawn | `E_SANDBOX_TEAM`, `team-not-created` |
| A delivered seat with a missing or contradictory descriptor (r2) | the in-sandbox apply | `seat-binding` (oats.aweb) |
| No provider, or more than one (r1) | every sandbox act | `E_SANDBOX_PROVIDER`, `none` or `ambiguous` |
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
| S3 Credential mount and the `forge` role: C8, the egress component, teamctl's inputs | `container/agent`, and teamctl on Juan's side | lane:juan | in parallel with S1 |
| S4 Broker contracts: C9 docs, then the client verbs | `docs/`, `lib/` | lane:product | after the first real provider |

Each spec carries its own reference pages and a release-notes entry of its own under
`docs/release-notes/next/` (r1):

- S1: [workspaces.md](../workspaces.md) (`sandboxes:`, the rollout rule, C2's
  refusals), [configuration.md](../configuration.md) (C3, C3b), [capabilities.md](../capabilities.md)
  and the manifest schema (the `sandbox` hook, C4), the CLI and JSON pages (C5),
  [servers.md](../servers.md) (the reserved prefix, C7), and readiness (C10).
- S2: the oats-aweb package's own docs (`identity.seat`, the registry setting,
  `oats.aweb-sandbox`'s settings, the ledger and reconcile).
- S3: [container.md](../container.md) (the credential fragment and its probe) and
  teamctl's docs on Juan's side.
- S4: the broker contracts' reference page, when it is built.

The live rehearsal runs on a disposable Linux Docker host, never on a person's machine.
It covers every "done means" line, with the egress and boundary probes' receipts kept as
evidence.
