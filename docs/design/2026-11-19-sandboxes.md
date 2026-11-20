# Sandboxes: boundaries declared in the workspace, started by `oats sync`

**Amended in r5 (2026-11-20), decided by both sides.** Placement no longer follows a
team. A sandbox lists the souls it may run and a ceiling on the capabilities they
compose, and it has no team. A soul's team is declared once, in `souls:`, and
placement never changes it. Messaging between agents is governed by aweb's policy,
whichever sandboxes they run in. What can an agent do? That's authorized per team or
per long-lived principal, by the resource's owner. This replaces the rule "a soul runs
in sandbox S when its resolved default team is S's team" everywhere below, and with it
C2's team routes. Items changed in r5 are marked "(r5)". The reviewed behaviour that
never depended on team placement is unchanged: the keyed replay, proof before a seat
is released (r4d), one owner of each schedule's clock, and explicit local selection.

**Status:** contracts decided, 2026-11-19. The product owner's side and aweb's maintainers agreed
C1–C10 and C3b as written at 0849ef12, with aweb's maintainers' four changes, which
the product owner's side accepted: the registry setting (C3, C6), a keyed `seat` (C4), the receipt of the host's
`remove-member` (C6) and the credential-mount probe (C8). The connector half of C9
stays designed only. Nothing is built yet. **Revised after review round 1** (marked
"(r1)" below): existing host homes, lifecycle calls made inside a sandbox, C4's
per-act wire shapes and provider selection, shared team aliases, mount overlap, the
first use's GitHub API route, managed server registrations, and the missing refusal
codes. Both sides decided those, with two precisions from aweb's maintainers, and decided the
`forge` egress role for the GitHub API. **Revised again after review round 2** (marked
"(r2)"): every real agent bind is checked, `status` mutates nothing, the routed
spawn's exact sequence and seat binding, the seat's service descriptor, provider state
scoped per deployment, a team not yet created, and the seat option's key. Both sides
decided the r2 additions, with `sandbox-state-orphaned`. **Revised after review round
3** (marked "(r3)"): the apply is bound to the preview's `decision.revision`; the seat
plan needs only the spawn key; the spawn hook learns the apply's key; the kernel keeps
the full routed request for replay; mint recovery; hardlinked credentials; the
resolvers are host infrastructure; the protected-sources input shape; and the `forge`
role's Host guarantee corrected to what a TLS pass-through can enforce. Both sides
decided the r3 contracts, with the domain-fronting risk statement and the pending
request's custody. **Revised after review round 4** (marked "(r4)"): the apply
evidence `bind` acts on, and the fence that keeps a replay away from an interrupted
delivery. **Revised after the round-4 delta read** (marked "(r4d)"): a seat is
released only on proof that no home can hold it, and the readiness and ordering text
that follows from that. A later change to a contract goes back to
both sides (the lane map's "Contract changes" line). When this record and a reference
page disagree after it is built, the reference page wins.

## The goal

One machine runs `oats sync` on a deployment, and the sandboxes that deployment lists
are built and started, with their boundaries declared once in the workspace. The first
use is scheduled knowledge-base ingestor agents on a cloud machine: they read untrusted
content, so they must not reach the engineers' agents, credentials or network.

**Done means:** on a Linux machine with Docker, a workspace that declares one sandbox,
and a deployment whose local file lists it, `oats sync` builds and starts the sandbox.
A workspace schedule whose `runsOn` names that machine spawns a soul the sandbox lists
inside it, with an identity minted on the host. The agent reaches only the declared
destinations and reads only the declared credentials. It messages only as its team,
its server and aweb's policy allow. For the ingestors that is a closed topology: their
own team on their own aweb server, with federation outbound off. That's a policy
configured for that use, not something placement implies (r5). Retiring the agent
removes its identity from the team. Delisting the sandbox stops it and destroys
nothing. All of this is shown by a live rehearsal and by the tests pinned in each spec.

## Decided with the product owner

- **Five separate decisions (r5).** A team is membership and messaging. A sandbox is a
  runtime boundary (its local state, mounts and egress). Placement is which sandbox a
  soul may run in. Identity is who an instance acts as. Authority is what it may do.
  Each is declared and checked on its own (The design, "Five independent decisions").
  This replaces "in v1 a team has at most one sandbox, so the two coincide" (decided
  2026-11-20 by both sides; the product owner's direction, and aweb's maintainers'
  requirement of 2026-11-18).
- **The one-team limit is the v1 provider's, not the model's (r5).** The model admits
  several teams in one sandbox, as co-resident trust the operator accepts. v1's
  provider, teamctl, serves one team per sandbox, so in practice v1 still runs one
  team per sandbox. That limit lifts when a provider serves several teams, and C1's
  reference text and the release notes say so plainly (decided 2026-11-20).
- **`souls:` is the one declaration of a soul's team (r5).** Its `default` is the team
  that soul's instances join, and its `teams` the others they may join. A pattern
  entry sets them for a set of souls. A sandbox places souls and never changes their
  team (decided 2026-11-20). Whether the key itself gets another name is a separate
  question, outside this record.
- **Credential files are a bridge for the whole sandbox (r5).** v1 ships read-only
  credential files mounted into the sandbox, because the first use has no other path
  to its tokens. Every process in the sandbox can read them. Read-only stops writes,
  not disclosure or use. A secret meant for one principal never goes through them
  (Credentials; decided 2026-11-20, replacing "acceptable with one team per sandbox").
- **OATS does not create or delete machines in v1.** Sync builds and starts listed
  sandboxes on a machine that already exists. Creating machines comes later, as a
  provider capability (decided 2026-11-19).
- **Kubernetes is a provider option (r5).** C4 is the contract a Kubernetes provider
  implements, as Compose through teamctl does. Its qualification and release scope
  are decided separately (decided 2026-11-20).
- **Both broker contracts are designed in this effort**: one for secrets, one for
  connectors (decided 2026-11-18). The connector broker stays designed only, with no
  build and no verb until a real provider exists (decided 2026-11-20).
- **Messaging isolation is by server, when a workload wants it:** an isolated team gets
  its own aweb server with federation outbound off. This needs no aw contract change
  (decided 2026-11-17). It's a policy chosen for that workload (the ingestors), not a
  consequence of placement (r5).
- **Kept as they are:** the word "team"; the schedule file, with `runsOn` naming the
  machine and no lease; there is no workspace list of shared deployments. A sandbox
  now lists its own souls; only the earlier "automatic team" stays rejected (r5).

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
- aweb's team bundle, `deploy/team` (`teamctl`, aweb's maintainers), renders one
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

### Five independent decisions (r5)

| Question | Who decides, and how |
| --- | --- |
| What runs where? | The shared workspace names sandboxes and the souls each may run, with a ceiling on their capabilities. A machine's local file selects which declared sandboxes it runs, and nothing else. A spawn or a schedule selects a soul; if the soul is placed, it resolves to an eligible sandbox (C2). |
| What does the runtime isolate? | Each sandbox has its own name, workload, private state, and declared egress and mounts. Several sandboxes may run on one machine. Agents that share readable state, credential files or a process trust boundary are mutually trusted. |
| Who can communicate? | aweb team membership, service routes, and contact, inbound and federation policy. A sandbox needs egress to a service to reach it. Sharing a sandbox joins no team. Sharing a team neither colocates agents nor gives them each other's local state. |
| Who is acting? | The identity provider binds each instance to an authenticated principal, from that instance's identity configuration, resolved per instance. Its messaging context, the team it joins, is resolved separately, from `souls:` and the documented fallbacks. Neither comes from its sandbox. |
| What can the actor do? | The resource's owner grants operations, to a team or to a long-lived principal, and the broker or provider checks them at use. Placement, a capability, membership or an address grants nothing on its own. |

One team per sandbox is a useful starting layout, and tooling may generate it as
explicit placement. The contract admits the same team in several sandboxes, and
several teams in one sandbox when the operator accepts that they share one trust
boundary, subject to each sandbox's egress and the owners' grants. v1's provider
limits this (C8, "One served team"). The ingestors are the case of a separate sandbox
combined with a separate team, server and federation policy, chosen for that workload.

**The case a reader can test (r5).** A reviewer and a deployer are in one team and
placed in two sandboxes. They exchange the messages aweb allows. Each keeps its own
state, session material and mounts. The reviewer can't use the deployment
credential, and revoking the deploy grant stops the next deployment without moving
either agent. The Acceptance section pins this.

### Who does what

| Piece | Owner | Does |
| --- | --- | --- |
| Declaration, validation, placement, CLI verbs, sync | the kernel (lane:product) | Reads `sandboxes:`, refuses the ways round the boundary, decides where a soul runs, calls the sandbox provider, and reports. No Docker. |
| Sandbox provider | a new capability, `oats.aweb-sandbox`, in the oats-aweb package | Turns a sandbox into teamctl input, runs teamctl, registers the sandbox as a server, prepares the in-sandbox deployment, mints and delivers seats, removes members at retire. |
| The team bundle | teamctl, aweb `deploy/team` (aweb's maintainers) | Three new inputs: the credential mount, the protected-sources file and the `forge` role (C8). |
| The agent image and Compose | `container/agent` (lane:juan) | A read-only credential mount fragment (C8). |

### Placement

A soul runs in sandbox S when S's `souls` lists it (C1), S is selected for the spawn
(C2), and this host lists S. Otherwise, a soul that no sandbox lists runs on the host,
as today, apart from `E_SANDBOX_HOST_AGENT` (C10). Placement never follows a team, and
a machine's local file never moves a soul: it only chooses which declared sandboxes
the machine runs (r5, replacing the derived rule "a soul runs in S when its resolved
default team is S's team").

- On a host that lists the selected sandbox S and has it started, a spawn (by hand, or
  by a schedule tick) is routed into S, as a remote spawn through S's server
  registration. S1 builds on #1912's floor (lane:juan, held): the task goes on stdin,
  the apply is bound to its preview and keyed, and a host below 0.69.15 is refused.
  This costs nothing, because the sandbox's kernel must already be the release with
  `sandboxes`. S1 does not merge before #1912. If #1912 is withdrawn, S1 itself
  requires the same three properties of the sandbox's kernel, rather than relying on
  today's fallbacks.
- On a host that does not list S, the spawn is refused with `E_SANDBOX_NOT_HERE`,
  naming S and the local key that would list it. A placed soul never falls back to
  the host.
- **After placement, the provider checks it can serve the instance's messaging
  context (r5).** Once the workspace's placement has selected S, the provider checks
  that it can serve the team the instance joins (C6, C8). A context it can't serve
  fails with a remedy. It never routes the spawn to another sandbox, changes the
  agent's team or falls back to the host.
- Inside S, its deployment refuses a spawn of any soul S does not list, and a routed
  request that names another sandbox (`E_SANDBOX_PLACEMENT`, C3b).

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

**Whose identity (r5).** The seat binds the instance's own identity kind and messaging
context, resolved per instance, never from the sandbox's name, a team label or an
alias. In v1 the one kind a sandbox takes is a local member seat. Its team T is the
team the instance joins: its soul's resolved default (`souls:`, or the fallbacks
workspaces.md gives). The kernel resolves T and hands it to the provider in the seat
plan and the `seat` act (C4). Two kinds stay out of sandboxes in v1, each refused
before anything is minted, with a remedy:

- **Extra teams** (`join-not-seated`): a join mints a per-team identity from that
  team's root, and no root enters a sandbox. So a spawn into a sandbox joins its
  default team only. Seats for extra teams are a later layout.
- **A resident's grant seat** (`grant-seat-not-sandboxable`): a grant seat calls the
  resident's custody service over a host-local Unix socket while it runs, not only at
  mint (oats-aweb's resident and grant-seat docs). That socket must never enter a
  sandbox, because it serves the resident's root key. A soul whose identity
  configuration makes it a grant seat is refused in a sandbox until a qualified,
  revocable remote delegation exists, which is aweb's to design. There is no
  downgrade from resident to local.

1. Before routing the spawn, the provider mints the instance's identity on the host
   from the host's root for the instance's team (`roots[T]`), into a private staging
   directory. Where that team's registry is private, the host deployment sets
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

The exact order of a routed spawn, with the value each step binds (r2, r3):

1. The kernel makes the spawn's idempotency key (`spawnKey`) and asks the provider for
   a seat plan (`plan`, target `seat`, with `instance: {soul, spawnKey, team}`, where
   `team` is T, r5). The plan is read-only and needs no instance name: it answers the
   seat ID (derived from `spawnKey`), its path and the `spawnProvider` options, or
   refuses a team it can't serve (C8, `team-not-served`). Its `planRevision` fences the
   sandbox's provider state, `spawnKey` and T.
2. The kernel runs the remote preview **with those options**. The preview chooses the
   instance name when the caller gave none (a schedule passes `--purpose`, not
   `--name`), and answers `decision.revision`, `D`, the hash of the whole decision
   that the apply's `--expect-decision` must match, as #1912 requires. The in-sandbox
   kernel admits a preview that carries a seat option without reading the seat; only
   an apply needs it.
3. **Before anything is minted, the kernel keeps the whole routed request** (r3,
   contract): server, `spawnKey`, `D`, the exact argv and provider options, and the
   task text, in `~/.oats/remote/<server>/pending/<spawnKey>.json` (0600, under the
   operator account, beside today's remote snapshots). It holds the task text, which
   #1912 took off argv for a reason, so: it is removed as soon as its seat settles
   (bound, released, or refused terminally); it is never copied into a receipt, a log
   or the ledger; and readiness reports one older than 24 hours as
   `sandbox-pending-stale`, naming the spawn key, never the task. S1 pins a test that
   its content never reaches a receipt, a log or a readiness line.
4. The kernel runs `seat` with the plan's revision, `spawnKey` and
   `instance: {name, soul, spawnKey, team, decision: D, settings}`. `settings` is the preview's
   composed settings for the capability the seat plan named
   (`spawnProvider.capability`), passed through unread, so the provider can refuse a
   seat it must not mint (C6, r5). The name, `D` and `settings` are inputs to the mint,
   not part of the plan's revision. The provider writes the ledger entry (`minting`, with
   `spawnKey`, `D`, T, the alias it will mint and the seat ID) before it mints, mints,
   records the certificate ID, delivers, and moves the entry to `delivered`.
5. The kernel runs the remote apply with `--expect-decision D` and
   `--idempotency-key spawnKey`, from the kept request, with the same provider options
   as the preview. No provider input changes between 2 and 5.
6. The kernel passes the apply's own answer to the provider (`bind`, C4), which acts
   on it by this table (r4, contract):

   | The apply's answer | Evidence | The seat |
   | --- | --- | --- |
   | Success, or the keyed replay of one | the home's `capabilityMeta["oats.aweb"].seat`, `{seatApi:1, seatId, certificateId, spawnKey}`, written by oats.aweb's spawn hook once the seat is connected, matching the ledger entry | `active` |
   | `E_DECISION_STALE` | the kernel's key recovery found no home holding `spawnKey` and refused before placing anything; the descriptor admits only that key (C6), so no home holds the seat | released (`spawn-failed`) |
   | `E_REQUIRED_HOOK_FAILED` or `E_HOOK_ENVIRONMENT_CONTRACT` whose details carry no `unconfirmed: true` (r4d) | the spawn's rollback confirmed its home is gone, so no home holds the seat, whatever the hook did before it failed (oats.aweb's `seat-binding` refusal arrives this way) | released (`spawn-failed`) |
   | `E_IDEMPOTENCY_CONFLICT` (r4d) | a home already holds `spawnKey` under another decision and may hold the seat | stays `delivered` |
   | `E_SPAWN_INCOMPLETE`, a hook failure with `unconfirmed: true`, a failed or uncertain seat connect, any other refusal, or no answer | none of these proves that no home holds the seat | stays `delivered` |

   A seat is released only on proof that no home can hold it (r4d): releasing revokes
   the member, which is right for a seat that no home holds, used or not, and wrong
   for one a live home holds. Before such a release the provider deletes any copy at
   `/state/seats/<seat-id>/` through the server route. If that deletion cannot be
   confirmed, the entry stays `delivered`, the kept request is deleted (its refusal
   was terminal), and readiness reports `sandbox-seat-unsettled`. The server route's
   "copy deleted" answer comes from the sandbox, so it is untrusted input: it can
   release only a seat of that sandbox's own ledger, and a false "deleted" can at
   worst revoke that sandbox's own member, never another's (r4d). `ok: false` alone is
   never evidence, and the provider reads no field of a refusal beyond its code and
   `unconfirmed`. S1 pins that the routed apply's answer, and its keyed replay, carry
   the new home's `capabilityMeta`; that the routed answer carries the host's refusal
   code and its `unconfirmed` detail unchanged; that `E_DECISION_STALE` is raised
   only when no home holds the key, before any placement or hook; and that a required
   hook's failure carries `unconfirmed: true` whenever the rollback could not confirm
   the home gone. S2 pins the meta oats.aweb writes and a `bind` test per row,
   including a prior home holding the key under another decision
   (`E_IDEMPOTENCY_CONFLICT`: the member is kept) and a failed copy deletion.
7. **The kernel settles a `delivered` seat** (r3, r4): `oats sandbox reconcile`, and
   so sync, first runs the provider's `reconcile` act, which settles interrupted mints
   and deliveries (below) and answers the ledger's seats. Only then does it replay a
   kept request, and only one whose ledger entry that answer shows durably
   `delivered`: a kept request whose entry is `minting` or `mint-uncertain` is never
   applied or replayed, and one whose seat was released is deleted. Each replay is
   unchanged, keyed by its `spawnKey`, and its answer goes to `bind` as in 6. A replay of an apply that was
   never sent is that apply, with its task, and a stale `D` refuses it terminally. The
   provider never builds or replays a spawn itself. Absence of the instance's name, or
   an unused seat directory, is never evidence. A `delivered` seat with no kept request
   stays `delivered`, and readiness reports `sandbox-seat-unsettled`.

**A mint whose outcome is uncertain (r3, contract).** An entry found in `minting` was
interrupted, and the registry may hold an identity whose result was never recorded, or
a seat copy may already have landed in the sandbox before the `delivered` write (r4).
The next mutating act reads the certificate ID from the staging copy, if one is there,
into the entry before it deletes that copy, and moves the entry to `mint-uncertain`.
With a certificate ID, it first deletes any copy at `/state/seats/<seat-id>/` through
the server route, then releases the seat (reason `spawn-failed`): no apply was sent
for it, because the apply follows the `delivered` write and its kept request is
fenced (step 7). If that copy cannot be confirmed deleted, the entry stays
`mint-uncertain` and is reported as unsettled. A pinned test kills the provider
between the copy landing and the `delivered` write, then runs reconcile and an
otherwise no-op sync: no home is created, the copy is gone and the member is
removed. Without one, the entry stays `mint-uncertain`, readiness
reports `sandbox-seat-unsettled` naming the alias, and the operator checks the team's
members. A replay of that `seat` key answers `unknown` and never mints again. A test
pins a kill after registration and before the receipt.

### Lifecycle calls made inside a sandbox (r1)

Minting and removing identities need the host's keys, so in v1 the host is the only
place a sandboxed instance is spawned from, and the host finishes every retire:

- **Spawn inside the sandbox.** The in-sandbox deployment has no root for any team.
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
  seat ID, `spawnKey`, `D`, instance, alias, certificate ID, team, state (`minting`,
  `mint-uncertain`, `delivered`, `active`, `removing`, `released`,
  `removal-uncertain`), and the receipt
  of each step. It outlives the remote home, and is the only evidence
  `remove-member` acts on.
- **Removal is written before it runs (r2).** The provider moves an entry to
  `removing`, durably, before it calls `remove-member`, then to `released` or
  `removal-uncertain` with the receipt. An entry found in `removing` was interrupted:
  it becomes `removal-uncertain`, and is never removed again automatically (C6).
- **Compensation.** If the mint succeeds but delivery fails, the provider releases
  the seat at once (reason `spawn-failed`) and deletes any delivered copy. After
  delivery, only step 6 or 7 above settles the seat.

### Credentials (v1)

**Two routes, with different scopes (r5).**

- **The credential files are a bridge whose scope is the whole sandbox.** The
  sandbox's reviewed entry in `oats-workspace.yaml`, `sandboxes.<id>.credentials`
  (C1), is the explicit approval: committing it approves exposing each named file to
  everything in that sandbox. Every process in the sandbox can read the files.
  Read-only stops writes, not disclosure or use. The bridge can never provide a
  per-principal secret, and a secret meant for one principal never goes through it.
  It ships in v1 because the first use, the knowledge ingestors, has no other path to
  its tokens: they reach the okf capability only as file settings today.
- **A per-principal secret goes through aweb's Secrets,** designed while its provider
  is pending:
  - A per-principal Secrets grant authorizes a defined operation in its verified
    team/installation context.
  - The secret may enter the environment of the designated, isolated runner job for
    that operation. Its value stays out of the agent's ordinary environment, shared
    mounts, persistent runtime metadata and results.
  - A value injected into an agent process is a disclosure to that process, and must
    be treated according to the actual execution boundary.
  - The reviewed workspace credential-file entry approves exposure to the whole
    sandbox trust group, and cannot provide a per-principal secret.

  The sandbox reaches Secrets through the egress base role `secrets`, which teamctl
  already declares. Egress permits access to the service; it changes neither the
  grants nor the runtime's disclosure boundary. Per-principal enforcement is marked
  designed until the provider exists. When it's built, its acceptance covers
  co-resident agents as well as separate sandboxes (aweb's Secrets design, §4.6 and
  §9; its runner protocol, §4.4).
- **Per team:** a team's credentials are a sandbox's files in a sandbox whose souls are
  all that team's, or a grant to a Secrets role the team's owner assigns. Neither
  needs a new OATS key. Ordinary membership never grants use.

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
source is the resolved path. A credential source with more than one hard link is
refused too (reason `hardlinked`, r3, contract): a second link could sit inside another
sandbox's work directory, where no path check sees it. This applies to every source in
the host's `credentials`, used or not, at every sandbox's start; the container's own
acceptance already refuses a public CA with more than one link. A pinned test puts a
hard link of one sandbox's credential in another sandbox's work directory.

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
substitutes an empty login directory, so it cannot stand in for this check. The
started-agent check reads the agent container by its exact identity (the container ID
teamctl's start returned, or an ownership label as in #1958), never by name alone: a
same-named container that is not this sandbox's refuses admission (a pinned negative
in S2 and S3). A failing
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
- **What it guarantees (r3, contract: corrects a decided item).** External roles are
  TLS pass-through: the proxy routes on the SNI and never sees the encrypted
  Host/`:authority` (egress README, "Optional external source and model roles").
  So `forge`'s guarantee is the external roles' own: exact SNI `api.github.com` and a
  validated public destination. The probe tests what the proxy enforces: an
  unlisted SNI is refused, and `api.github.com` resolves only to the proxy. **The
  risk that remains:** with SNI `api.github.com` admitted, the connection reaches
  whatever GitHub's front end for that name serves to a Host it accepts; domain
  fronting is not refused here. So the one-repository credential is the control that
  matters. A Host
  that differs from the SNI inside the encrypted stream, on a `forge` or another
  admitted connection, is not refused by this component; whether GitHub serves it is
  GitHub's. Refusing it would need TLS interception, which this record does not
  propose. This statement replaced the earlier "SNI/Host mismatch" item; both sides
  decided it in r3, with the risk statement above.
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
- Order: the egress component and teamctl first, on lane:juan (aweb's maintainers launch
  that developer once this record is final); then C1's value, on the kernel side.

### What sync does

After its current steps (the lock, package souls, the automation snapshot), `oats sync`
reconciles each sandbox the local file lists:

- not built, or built from other inputs: build and start it;
- stopped: start it;
- running with the same inputs: no infrastructure change (`action: "none"`).

Whatever the action, sync then reconciles each listed, running sandbox's seats
(`oats sandbox reconcile`'s work: the provider's `reconcile` act, then the replay of
each kept request whose entry it answers durably `delivered`, as in step 7 of the
Identities section) (r4d), so a self-retire is completed by the next sync even when nothing else changed
(r3). A pinned test: a self-retire, then an otherwise no-op sync, removes the member.

A sandbox declared in the workspace but not listed locally is never started. A sandbox
listed earlier and now delisted is stopped, never destroyed: its state and its
identities are kept. A later schedule tick whose spawn selects it is refused
(`E_SANDBOX_NOT_HERE`), and no provider receipt implies a retire or the removal of
compute (r5). The provider keeps the
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

### C1. Workspace `sandboxes:` (new root key; r5)

```yaml
teams:
  eng:         { team: "eng:example.org" }
  ingest-team: { team: "ingest:example.org" }
defaultTeam: eng
souls:                                       # the one declaration of each soul's team
  "*": { default: eng }                      # default: the team this soul's instances join
  knowledge/*: { default: ingest-team }      # a pattern sets it for a set of souls
  knowledge/knowledge-reviewer: { default: eng, teams: [ingest-team] }   # a deliberate bridge
sandboxes:
  ingest:
    souls: [knowledge/knowledge-ingestor]    # who may run here; never their team
    capabilities: [oats.core, oats.aweb, oats.okf]   # a ceiling; [] permits none
    egress: [model, source, forge]           # closed set, added to the base routes
    credentials: [sources-read, knowledge-propose]   # names only: a whole-sandbox bridge
    description: Knowledge ingestors         # optional
```

- **The key** is the sandbox ID, matching `^[a-z0-9]$|^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$`.
  Its storage, status, server registration and lifecycle are keyed by that ID and the
  deployment, never by a team label, a team ID or an agent alias.
- **`souls`** (required, non-empty) is the workspace's placement allowlist, and the one
  place it is declared. Each entry is an exact soul reference as `souls:` keys spell a
  single soul (`<member>/<soul>` or `<package>/<soul>`), never a pattern. Entries are
  distinct (`duplicate-entry`). It makes a soul eligible to run here, and spawns
  nothing: spawns and schedules still decide which instances run. A soul may be listed
  by several sandboxes; C2 says how a spawn chooses. A reference no member or package
  offers is reported by readiness (`sandbox-soul-unknown`), and a spawn of it is
  refused (`E_SANDBOX_PLACEMENT`, `soul-unknown`).
- **`capabilities`** (required) is a ceiling over the fully resolved composition of each
  instance placed here, including workspace defaults, the soul's own layer and required
  dependencies. `[]` permits none. A composition that needs a capability outside it is
  refused at the spawn's preview, before any seat is staged (`E_SANDBOX_PLACEMENT`,
  `capability-not-admitted`, naming the capability and its reference). The remedy is a
  workspace soul, or a variant of one, whose composition fits. The runtime never strips
  a required capability, and never admits unpinned code. The sandbox provider's own
  capability never composes inside a sandbox (C3b). The image's contents and the
  egress are separate limits, and choosing software grants nothing.
- **No team (r5).** A sandbox has no `team` field. `souls:` is the one declaration of
  each soul's team (Decided with the product owner), and placing a soul never changes
  it. The `team` field of the earlier, unreleased shape is refused when the file is
  read (`E_WORKSPACE_SCHEMA`, reason `sandbox-team-field`). The remedy names the
  migration: the souls whose default team it was go in `souls`, and a `capabilities`
  ceiling is added, under the same sandbox ID. There's no silent inference from a team.
- **One served team, in v1 (r5).** The model admits several teams in one sandbox. v1's
  provider, teamctl, serves one team per sandbox (C8), so in practice v1 runs one team
  per sandbox. That's the provider's limit, not the model's, and it lifts when a
  provider serves several teams. C1's reference text and the release notes say so.
- `egress` is a subset of `{model, source, forge}` (`forge` behind feature
  `sandbox-egress-forge`), because those are the external roles the egress component
  supports. Adding another destination is a change to the egress component, not a
  free-form list.
- `credentials` names match `^[a-z0-9][a-z0-9-]{0,62}$`, and are distinct. Committing
  them approves exposing each file to the whole sandbox (Credentials).
- `egress`, `credentials` and `description` are optional; the two lists default to
  `[]`. A duplicate in any list is refused (reason `duplicate-entry`) (r1).
- **A team not yet created (r2, r5).** A shared team may omit its provider id
  (declared, not created). A soul whose team has none stays valid, so other hosts are
  not refused. A routed spawn of it refuses (`E_SANDBOX_TEAM`, reason
  `team-not-created`), and so does a start whose provider would serve that team (C8),
  with the existing remedy: its owner runs `oats aweb setup`, then commits the id. The
  id is never inferred from the label or an active team.
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

### C2. Choosing a sandbox (r5: replaces the team routes)

A soul's **eligible sandboxes** are the workspace's sandboxes whose `souls` lists it.
The choice is made from the shared workspace, at the spawn or the schedule, before
anything happens:

- **None:** the soul is a host soul. It runs on the host as today, apart from
  `E_SANDBOX_HOST_AGENT` (C10).
- **Exactly one:** it's inferred.
- **More than one:** the spawn names its target. That's `oats spawn <soul> --sandbox
  <id>`, and a `run: spawn` schedule's `sandbox: <id>` field, both new contracts (the
  CLI, and the schedule file). A spawn without one is refused (`E_SANDBOX_PLACEMENT`,
  reason `sandbox-ambiguous`, naming the candidates and the flag or field). It's
  refused even when this host lists only one of the candidates: a local file never
  chooses a placement.
- **A named target** that the workspace doesn't declare (`sandbox-unknown`), or that
  doesn't list the soul (`sandbox-not-eligible`), is refused with
  `E_SANDBOX_PLACEMENT`. Both remedies list the soul's eligible sandboxes and say to
  name one of them. `sandbox-not-eligible` also says the soul can be added to that
  sandbox's `souls` in the workspace, by a reviewed change. A target this host doesn't list is refused with
  `E_SANDBOX_NOT_HERE`. Each refusal comes before any effect, and none falls back to
  the host.
- `runsOn` still names the one machine that owns a schedule's clock. `sandbox:` names
  only where its spawn runs.

**Withdrawn (r5).** C2's team routes go: `sandboxed-team-not-default`,
`sandboxed-team-by-wildcard`, `sandboxed-team-local`, `sandboxed-team-alias` and
`sandbox-team-taken`. So does the rule that `"any"` excludes sandboxed teams. They
existed only because placement followed the default team. Now a team reached through
a wildcard, an extra team or a local default places nothing, and an eligible extra
membership is never a way to a placement or a grant. Operators who want a narrower
communication policy configure it on the messaging service and in egress. Messages
aweb allows can carry data between sandboxes, so separate storage promises no data
isolation across a permitted conversation.

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
  `sandbox-host-name-required`) (r1). The list selects which sandboxes this machine
  runs, and nothing else: it holds sandbox IDs and infrastructure facts only, and it
  can't place, move or choose between souls (C2, r5).
- `credentials` uses the kernel's existing `fromFile` form. A listed sandbox whose
  declared credential has no source here refuses its start, naming the credential.
- The teamctl file holds infrastructure only (images, network, ports, state directory,
  limits). The provider refuses a file that sets a boundary field the workspace owns
  (`team.id`, which v1's provider derives from the souls the sandbox lists (C8, r5); the role booleans `egress.external.source`, `.model` and `.forge`,
  `aweb.federationOutbound`): boundaries are declared once. The refusal is
  `E_SANDBOX_DEPLOYMENT`, reason `boundary-field`, naming the field (r1). The
  resolvers the external roles need, `egress.external.resolvers`, are host
  infrastructure and stay in the teamctl file; a sandbox whose workspace egress names
  an external role and whose file gives no resolvers refuses its start (reason
  `resolvers-required`) (r3, contract). The provider writes the role booleans from
  the workspace. Example: `egress: { external: { resolvers: [1.1.1.1, 9.9.9.9] } }`
  in the teamctl file, with C1's `egress: [model, source, forge]`.
- **A private registry.** oats.aweb refuses an ambient `AWID_REGISTRY_URL`
  (awebai/oats-aweb#284), so where the instance's team's registry is private the setting
  is written twice: `settings.oats.aweb.registry` on the host deployment, for the mint
  and for `remove-member` (C6), and the same key in the sandbox's `settings`, which the
  provider writes into the in-sandbox local file. Without the in-sandbox one, the
  in-sandbox spawn refuses with `registry-setting-required`.

### C3b. `oats-local.yaml` inside a sandbox: `sandbox: { self: <name> }` (new root key)

The provider writes it into the in-sandbox deployment's local file. It is a contract of
its own because a kernel reads it:

- `self` must name a sandbox the workspace declares. That deployment then spawns only
  souls that sandbox's `souls` lists, within its `capabilities` ceiling, and refuses
  others with `E_SANDBOX_PLACEMENT` (r5). A routed request must name the sandbox,
  soul and composition its preview showed, and its sandbox must equal `self`. `D`
  already binds the composition, and the `self` check refuses a request that names
  another sandbox. A request through the sandbox's own deployment can never place a
  soul on the host or in another sandbox.
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
`stop`, `status`, `reconcile`, `seat`, `bind` or `release`, one JSON request on stdin, and reads one JSON
answer on stdout. The kernel holds a per-sandbox lock around every act but `plan` and
`status`, so two mutating acts on one sandbox never run at once (a second gets
`E_LIFECYCLE_BUSY`). The lock, the plan revisions and the idempotency keys are all
scoped to the deployment and the sandbox (C7's deployment key) (r2). A
hook that exits nonzero, times out or prints anything but one valid answer is read as
`state: "unknown"` with problem `E_SANDBOX_PROVIDER`, reason `hook-failed`.

**Every request** carries:

```json
{"sandboxApi":1,"act":"start","sandbox":"ingest","host":"cloud-1",
 "souls":[{"soul":"knowledge/knowledge-ingestor",
           "team":{"label":"ingest-team","id":"ingest:example.org"}}],
 "capabilities":["oats.core","oats.aweb","oats.okf"],
 "egress":["model","source"],
 "credentials":[{"name":"sources-read","path":"/srv/…"}],
 "workspace":{"url":"…","commit":"…","lock":"<sha256>"}}
```

There's no sandbox-wide `team` (r5). `souls` carries each listed soul with the team
its instances join, as the kernel resolved it from `souls:`, so a provider that serves
one team (C8) can check what it would serve. The kernel never derives an identity
from the sandbox's name, a team label or an alias.

and by act:

| Act | Extra request fields | Answer fields beyond the envelope |
| --- | --- | --- |
| `plan` | `target`: `start`, `stop`, `reconcile`, `seat`, `bind` or `release`; for target `seat`, `instance: {soul, spawnKey, team}` (r5); for `bind` and `release`, the `instance` fields of that act | `planRevision`, `actions: [{step, detail}]`; for target `seat` also `seat: {id, path}` and `spawnProvider: {capability, options: {<key>: <value>}}` |
| `start`, `stop`, `reconcile` | `planRevision`, `idempotencyKey` | `server`; for `reconcile`, `seats` as in `status` |
| `status` | none | `server`, `seats: [{seatId, instance, alias, certificateId, team, state}]` |
| `seat` | `planRevision`, `idempotencyKey`, `instance: {name, soul, spawnKey, team, decision, settings}` (`decision` is `D`, the remote preview's `decision.revision`; `team` is the team the instance joins; `settings` is the preview's composed settings for the seat's capability, passed unread; r5) | `seat: {id, path, alias, certificateId, team}` |
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
  `bind` from the routed apply's answer or the kernel's keyed replay of it (for
  `delivered` seats), `reconcile` from the sandbox's untrusted report (for `active`
  seats) and the interrupted-mint rule. The provider runs no spawn. The
  staging sweep for a killed hook runs in the mutating acts only: under the lock no
  `seat` can be running, so any staging copy found is a leftover.
- An act whose outcome is uncertain answers `unknown`, never `ready`.

### C5. CLI and JSON

- `oats sandbox status [--json]`, `oats sandbox start|stop <name> (--plan | --plan-revision <r> --idempotency-key <k>)`.
- `oats sandbox status --json` answers
  `{sandboxApi:1, host, sandboxes:[{name, souls, capabilities, listedHere, state, server, egress, credentials:[{name, source:"present"|"missing"}], problems}]}`.
  A sandbox has no `team` (r5): what the sandbox allows (`souls`, `capabilities`) is
  shown apart from the team each instance actually joined, which is on its seat
  (`seats[].team`). The answer's readers change with it (below).
- `oats spawn <soul> --sandbox <id>` selects among a soul's eligible sandboxes, and a
  `run: spawn` schedule's `sandbox: <id>` does the same (C2, r5). Both are new
  contracts. `--sandbox` is refused together with `--server`, which names a target of
  its own (`E_BAD_ARGS`).
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
  runs on its own what sync runs for each sandbox: the `reconcile` act, then the
  replays of the kept requests whose entries it answers durably `delivered` (r2, r3,
  r4d).
- **That these are additive must be shown, not assumed.** The readers of sync's answer
  are `packages/desktop/server/workspace-sync.mjs`,
  `packages/desktop/renderer/workspace-sync-view.mjs`,
  `packages/client/deployment-data.mjs` and `packages/client/workspace-cli.mjs`. The
  readers of the status answer are the client's roster readers and the warm reader. S1
  lists every reader it finds, with file and line, and pins one test per reader feeding
  it an answer with the new fields. If a reader refuses unknown fields, the change is
  not additive: that answer's API version goes up, and the reader changes first, in its
  own PR. The sandbox status answer had no released shape, so dropping `team` breaks
  no release. The two client readers already merged for this effort (#2016, sync's
  exit; #2021, a spawn refusal's words) read no `team`. S1 checks both against r5's
  shape, including the new `E_SANDBOX_PLACEMENT` reasons (r5).

### C6. oats.aweb settings and behaviour

- `identity.seat` (new): an absolute path to a one-use seat delivered by the host. The
  spawn copies it the way it copies `identity.source`, takes no retained-seat lock, and
  deletes the delivered copy after connecting. It is refused together with
  `identity.source` and with global mode. A preview reads nothing from it; an apply
  needs it.
- **The seat descriptor (r2).** The retained route reads its service from the
  source's `workspace.yaml`, which is not an authority file. A delivered seat instead
  carries `seat.json`, written by the host at mint:
  `{seatApi:1, seatId, spawnKey, service, team, alias, certificateId}`, where `team` is
  the team the instance joins and `service` is that team's aweb origin. That origin is
  one the sandbox's egress `aweb` role admits, and in v1 it's the sandbox's own server
  (C8, r5).
  The spawn reads its service from that descriptor only, never from `OATS_AWEB_URL` or
  a copied coordination workspace, and checks it: `team` equals the team the spawn
  resolved, `alias` equals the instance name, `spawnKey` equals the apply's key, and
  `service` is a plain https origin. The apply's key reaches the spawn hook through a
  new, generic hook variable, `OATS_SPAWN_IDEMPOTENCY_KEY`, set by the kernel on a
  keyed apply and absent otherwise (r3, contract: the hook environment; S1 sets it and
  pins it, S2 consumes it). An unkeyed apply with `identity.seat` is refused (reason
  `seat-binding`, field `spawnKey`); the provider never takes the expected key from
  the descriptor it validates. A missing, malformed or contradictory descriptor
  refuses the spawn (reason `seat-binding`, naming the field). The host's registry pin
  is a separate setting (C3), never the service.
- **Seats a sandbox doesn't take in v1 (r5),** refused by `seat` before anything is
  minted, from the `settings` it's handed (step 4):
  - A spawn into a sandbox that asks to join a team beyond its default (`join=`):
    `E_SANDBOX_PLACEMENT`, reason `join-not-seated`. The remedy says that extra-team
    seats are a later layout, and that the soul's other teams stay eligible on the host.
  - A soul whose identity settings make it a resident's grant seat:
    `E_SANDBOX_PLACEMENT`, reason `grant-seat-not-sandboxable`. The remedy says to run
    it on the host, or to remove it from the sandbox's `souls`, until a qualified
    remote delegation exists. There's no downgrade from resident to local.
  The provider removes only a membership it minted for a disposable seat and can prove
  it owns. Stop, restart and removing a sandbox never retire a resident or revoke its
  other memberships.
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
- **A moved deployment.** Moving or renaming the deployment directory changes its key
  and orphans its sandboxes' ledger, lock and receipts. Readiness reports
  `sandbox-state-orphaned` when provider state under another key holds a sandbox this
  deployment lists, naming the old key. It is never adopted automatically; the remedy
  names moving the directory back, or the manual adoption step S2 specifies.

### C8. teamctl and the container (aweb's maintainers)

- **Credential mount:** a new teamctl input, `agents.credentials`, a map from name to a
  host file. It is rendered as read-only binds at `/run/oats-credentials/<name>` through a
  new `container/agent/compose.agent.credentials.yaml` fragment. teamctl's
  `agents.secrets` stays the harness login only.
- **Probe:** the boundary probe asserts that each credential mount is read-only, that
  it lies only under `/run/oats-credentials`, and that no undeclared credential path is
  mounted. Its receipt joins the probe's `--json` receipts (#1958).
- **Protected sources (r1, r2, r3):** the provider writes one JSON file per start,
  `{"protectedSourcesApi":1, "hardDenied":[<path>], "credentialSources":[<path>],
  "declaredBinds":[{"source":<path>,"target":"/run/oats-credentials/<name>"}]}`, with
  real paths, and gives it to teamctl as a new input, `agents.protectedSourcesFile`
  (contract: teamctl's schema, aweb's maintainers). teamctl passes it to the container's
  mount acceptance, which takes those three parts and, on the started
  agent's actual mounts, asserts that no bind equals, contains or lies inside a
  protected path, the declared credential binds being the only exception to the
  credential-source part. It runs before any seat is admitted.
- **Optional, later:** a slimmer profile without Secrets and Logs. v1 runs with
  teamctl's four base routes.
- teamctl's changes are these three inputs: `agents.credentials`,
  `agents.protectedSourcesFile` and `egress.external.forge`. OATS reads its exit codes
  as they are.
- **One served team (r5): v1's provider limit, not the model's.** teamctl runs one
  team's bundle: its aweb server, egress and agent container. So `oats.aweb-sandbox`
  takes the bundle's team from the souls the sandbox lists (C4's request carries each
  one's team). It writes it as teamctl's `team.id`, which no host file may set (C3).
  - **What it refuses:** `oats sandbox start`, sync's start, the seat plan and `seat`
    refuse, before any seat, a sandbox whose souls join more than one team, or a team
    whose service isn't the bundle's: `E_SANDBOX_TEAM`, reason `team-not-served`. Each
    case has its own remedy, and neither changes a team or moves a spawn:
    - **Several teams:** the remedy names the teams found, and says to list the other
      team's souls in a sandbox of their own.
    - **Another service:** the remedy names the team's service and the bundle's
      server. It says to place that team's souls in a sandbox whose bundle serves that
      service, or to point this sandbox's bundle at it.
  - **What the limit covers:** only the combinations of membership inside one sandbox.
    Messaging between agents of one team in separately placed sandboxes stays
    governed by aweb's policy.
  - **A separate question:** whether teamctl can run two sandboxes for one team (two
    bundles, one team's server) is aweb's maintainers' to say. Until they do, the
    Acceptance case "same team, separate sandboxes" is pending for v1's provider.
  - A start never mints a team. The provider reaches only the service origins its plan
    names, with no ambient URL fallback. A runtime that can build only a team bundle
    reports that limit before it admits a seat, and never claims independent placement
    it can't deliver.

### C9. Broker contracts (designed now, built against the first real provider)

**Authority (r5).** Both brokers check the verified actor, its acting team or
installation context, the operation and resource it is authorized for, and its current
grant or session scope, plus any approval required. They check at admission and again
at dispatch, fail closed on missing, ambiguous, expired or revoked authority, and
record the decision without returning a secret value.
- **Scope:** team scope is a policy the owner authorizes within that team's
  installation. Identity scope is a grant to one stable principal, with any required
  team context still verified. A grant in one team can't be spent in another because
  the DID matches.
- **Delegation:** asking a more privileged agent over messaging doesn't authorize it to
  act for the caller; an explicit delegation must cover the operation.
- **Revocation and replacement:** revocation denies new dispatches at the applicable
  fence, though effects already dispatched may complete. Replacing a resident's
  runtime session keeps its principal without widening its authority.
- **No fallback:** a missing broker or an unsupported provider is reported as
  unavailable, never replaced by a shared mounted file.

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
  connectors broker built or filed, and whether one is planned is for aweb's maintainers to say. The
  shape is offered so that a provider-neutral gateway can implement it. It stays
  designed only, and is not built, until aweb's maintainers say whether aweb plans a connectors
  broker and a provider exists.
- **Order:** both contracts are agreed in this record. Each is built when its first real
  provider ships, and checked against that provider's interface before it is released.
  This keeps the product owner's decision to design both now, and aweb's maintainers' point that a public
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
- `sandbox-seat-unsettled`: a `mint-uncertain` seat, with or without a certificate
  ID (r4d: one whose delivered copy could not be confirmed deleted stays here); a
  `delivered` seat with no kept request, including one whose release waits on a copy
  deletion that could not be confirmed; or a `delivered` seat whose last replay
  answered `E_IDEMPOTENCY_CONFLICT` or `E_SPAWN_INCOMPLETE` (r2, r3, r4d). A pinned
  negative: a known certificate ID whose copy deletion fails gives no replay, no home,
  and this item;
- `sandbox-state-orphaned`: provider state under another deployment key for a
  sandbox this deployment lists (r2);
- `sandbox-pending-stale`: a kept routed request older than 24 hours, named by its
  spawn key, never its task (r3);
- `sandbox-soul-unknown`: a sandbox's `souls` names a soul no member or package
  offers (r5).

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
| A credential source with more than one hard link (r3) | `oats sandbox start`, sync's start | `E_SANDBOX_CREDENTIAL`, `hardlinked` |
| An external egress role with no resolvers in the teamctl file (r3) | `oats sandbox start`, sync's start | `E_SANDBOX_DEPLOYMENT`, `resolvers-required` |
| An unkeyed apply carrying `identity.seat` (r3) | the in-sandbox apply | `seat-binding` (oats.aweb), field `spawnKey` |
| `sandbox-<name>` registered by someone else (r1) | `oats sandbox start`, sync's start | `E_SANDBOX_SERVER`, `server-taken` |
| `sandbox-<name>` owned by another deployment (r2) | `oats sandbox start`, sync's start | `E_SANDBOX_SERVER`, `server-owned-elsewhere` |
| The team an instance joins, or the team a start would serve, has no provider id yet (r2, r5) | `oats sandbox start`, sync's start, a routed spawn | `E_SANDBOX_TEAM`, `team-not-created` |
| The sandbox's souls join more than one team, or a team whose service isn't the bundle's: v1's provider limit (r5) | `oats sandbox start`, sync's start, the seat plan, `seat` | `E_SANDBOX_TEAM`, `team-not-served` |
| A delivered seat with a missing or contradictory descriptor (r2) | the in-sandbox apply | `seat-binding` (oats.aweb) |
| No provider, or more than one (r1) | every sandbox act | `E_SANDBOX_PROVIDER`, `none` or `ambiguous` |
| A placed soul whose selected sandbox this host does not list or run | `oats spawn`, a schedule's spawn | `E_SANDBOX_NOT_HERE` |
| A soul not listed by this sandbox, or a routed request naming another sandbox, inside it (r5) | the in-sandbox `oats spawn` | `E_SANDBOX_PLACEMENT` |
| Several eligible sandboxes and no `--sandbox` or schedule `sandbox:` (r5) | `oats spawn`, a schedule's spawn | `E_SANDBOX_PLACEMENT`, `sandbox-ambiguous` |
| A named target that isn't declared, or doesn't list the soul (r5) | `oats spawn`, a schedule's spawn | `E_SANDBOX_PLACEMENT`, `sandbox-unknown` or `sandbox-not-eligible` |
| A soul reference no member or package offers (r5) | `oats spawn`, a schedule's spawn | `E_SANDBOX_PLACEMENT`, `soul-unknown` |
| A composition outside the sandbox's `capabilities` ceiling (r5) | the spawn's preview | `E_SANDBOX_PLACEMENT`, `capability-not-admitted` |
| A join beyond the default team, into a sandbox (r5) | `seat`, before the mint | `E_SANDBOX_PLACEMENT`, `join-not-seated` |
| A resident's grant seat, into a sandbox (r5) | `seat`, before the mint | `E_SANDBOX_PLACEMENT`, `grant-seat-not-sandboxable` |
| A sandbox entry with a `team` field (the unreleased shape) (r5) | reading the workspace file | `E_WORKSPACE_SCHEMA`, `sandbox-team-field` |
| A local `sandboxes` entry the workspace doesn't declare, a duplicate, or a listed sandbox with no `host.name` (C3) | reading the local file | `E_WORKSPACE_SCHEMA`, `sandbox-unknown`, `duplicate-entry` or `sandbox-host-name-required` |
| `sandbox: {self}` combined with `sandboxes`, `credentials`, local `teams` or a local `defaultTeam` (C3b) | reading the in-sandbox local file | `E_WORKSPACE_SCHEMA`, `sandbox-self-conflict` |
| A new `oats server add` or `connect` with the reserved `sandbox-` prefix (C7) | `oats server add`, `oats server connect` | `E_SERVER_INVALID`, `reserved-prefix` |
| A private registry with no in-sandbox `settings.oats.aweb.registry` (C3) | the in-sandbox spawn | oats.aweb's reason `registry-setting-required`, carried by the kernel's refusal of a required hook's failure |

Reasons in the table that a provider gives, such as `seat-binding` and
`registry-setting-required`, reach the caller inside the kernel's own refusal for a
failed required hook. The kernel's codes stay the kernel's; the provider adds only the
reason and its remedy (r5).

**Why `E_SANDBOX_HOST_AGENT`.** The controller key, the team roots, the credential
sources and any resident's custody service sit under the account that runs the
deployment, because that account mints the seats and serves the residents. A
host-side agent of the same deployment would run as that account and could read them,
or call the custody socket (r5). So in v1, a
deployment that lists a sandbox runs every agent in a sandbox. Agents that belong on the
host run from another deployment, under another OS user. This replaces checking file
modes against users, which cannot be proved from inside one account.

## Left out of v1

Each restriction sits beside the feature it qualifies (the section named), and goes in
the release notes when that feature ships (r5).

- Creating or deleting machines.
- **Several teams in one sandbox, with teamctl:** the model admits it, but v1's provider
  serves one team per sandbox (C8, `team-not-served`).
- **Seats for extra teams** in a sandbox (Identities, `join-not-seated`).
- **A resident's grant seat** in a sandbox, until a qualified, revocable remote
  delegation exists (Identities, `grant-seat-not-sandboxable`).
- **Kubernetes qualification.** C4 is the contract a Kubernetes provider implements,
  and v1's provider is Compose through teamctl. A Kubernetes provider is claimed only
  after the Acceptance section's Kubernetes case passes on an existing cluster, and its
  release scope is decided separately.
- **Secrets and connector capabilities:** designed only (C9). Per-principal secrets
  are enforced once the provider exists (Credentials).
- Human IDs by default and `oats sandbox adopt`. These wait on aweb's maintainers' decision
  on reversing "strictly opt-in" (#1665). Adoption is specified once
  those are settled.
- Publishing the image, and its digest in the lock.

## Alternatives rejected

- **A groups block with its own soul list:** it writes the soul-to-team mapping twice.
- **Sandbox fields inside team entries:** no named container would remain to list, build
  or show.
- **`hostedBy: everyone` for containers:** Docker could start on a laptop that never
  asked for it.
- **A sandbox that gets an automatic team:** rejected by the product owner. A sandbox
  listing its own souls was rejected with it at first, then adopted in r5, without the
  team.
- **Placement derived from the default team (r1–r4d):** it tied messaging to the
  runtime boundary, so one team could never span sandboxes, and one sandbox could
  never hold two teams without changing the model. Replaced in r5 by explicit
  placement.
- **The local file choosing between eligible sandboxes (r5 draft):** it let a machine's
  file decide a placement, which only the shared workspace decides. Replaced by the
  explicit selector (C2).
- **An optional `capabilities` list meaning "everything" (r5 draft):** the ceiling is
  required, so it never has to be guessed.
- **A `team:` alias for a `souls:` entry's `default`:** two spellings of one key in a
  closed schema. Left out of this amendment by both sides.
- **Docker in the kernel:** the kernel stays runtime-neutral; the provider owns
  containers.
- **The container's own clock beside the host's:** two owners of one schedule.
- **Free-form egress origins:** the egress component's guarantee rests on a closed set
  of roles.
- **Credentials through teamctl's `agents.secrets`:** that mount is the harness login
  only, by its own contract.
- **A lease service for schedules:** none exists, and `runsOn` already names one host.

## Acceptance (r5)

| Case | What it shows |
| --- | --- |
| Same team, separate sandboxes | A reviewer and a deployer in one team, in two sandboxes, exchange the messages aweb allows. Their state, session material and mounts stay separate, and the reviewer can't use the deployment credential. The same holds with cross-team messaging allowed, and with it denied, by aweb's policy. Pending for v1's provider until aweb's maintainers say whether teamctl runs two sandboxes for one team (C8). |
| Teams independent of the runtime | Changing a soul's default team, or a label's alias, moves no soul. Two teams in one sandbox, accepted as co-resident trust, run on a provider that serves several teams; v1's provider refuses it with `team-not-served`. One team in two sandboxes introduces no second team. |
| Placement and capability refusals | An ambiguous target, a wrong host, a wrong sandbox, a missing or extra capability, a forged seat binding and an unavailable provider route each fail with the responsible decision and a remedy, before any placement succeeds or usable authority leaks. |
| Identity apart from the route | Designed while grant seats stay on the host. A grant-backed agent restarts with the same stable DID and a new valid session; one without public inbound reach stays usable as the same principal; an alias match, a wrong team or a stale session can't spend its grant; revocation stops the next dispatch with both sandboxes left in place. |
| Target and policy | With Compose: start, authorized work, stop, resume and delist, with separate state and one clock. The same contract against an existing Kubernetes cluster, including storage across a workload replacement and a check of the network policy, before that provider is claimed. |

## Delivery

| Spec | Surface | Lane | Builds first |
| --- | --- | --- | --- |
| S1a Kernel, the part placement doesn't touch: C1's shape, C3, C3b, C4's caller and runner, C5's lifecycle and sync, C7, the kept-request custody and replay fence, readiness | `lib/`, `bin/`, schemas, `docs/` | lane:product | first; reuses the reviewed work of #2025 that no team placement touches, merged after #1912's hold lifts |
| S1b Kernel, placement: C2's selection, the seat's team and settings (C4), C3b's checks, the r5 refusals (C10), the status answer without `team` | `lib/`, `bin/`, schemas, `docs/` | lane:product | after S1a |
| S2 Provider: `oats.aweb-sandbox`, C4's hook, C6, C7, C8's one served team, the registry setting (C3) | the oats-aweb package | lane:setup, aweb's maintainers read first | after S1b's contract is merged |
| S3 Credential mount and the `forge` role: C8, the egress component, teamctl's inputs | `container/agent`, and teamctl on aweb's maintainers' side | lane:juan | in parallel with S1 |
| S4 Broker contracts: C9 docs, then the client verbs | `docs/`, `lib/` | lane:product | after the first real provider |

Each spec carries its own reference pages and a release-notes entry of its own under
`docs/release-notes/next/` (r1):

- S1a and S1b: [workspaces.md](../workspaces.md) (`sandboxes:`, the rollout rule,
  C2's selection, and the one-served-team limit stated plainly), [configuration.md](../configuration.md) (C3, C3b), [capabilities.md](../capabilities.md)
  and the manifest schema (the `sandbox` hook, C4), the CLI and JSON pages (C5),
  [servers.md](../servers.md) (the reserved prefix, C7), and readiness (C10).
- S2: the oats-aweb package's own docs (`identity.seat`, the registry setting,
  `oats.aweb-sandbox`'s settings, the ledger and reconcile).
- S3: [container.md](../container.md) (the credential fragment and its probe) and
  teamctl's docs on aweb's maintainers' side.
- S4: the broker contracts' reference page, when it is built.

Who builds each slice is decided apart from this record, and reviewing the record
commits no side to building one (r5).

The live rehearsal runs on a disposable Linux Docker host, never on a person's machine.
It covers every "done means" line and the Acceptance cases v1's provider can run,
with the egress and boundary probes' receipts kept as evidence.
