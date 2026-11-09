# Workspaces: one workspace per organisation, members are trust, nothing is installed

This is the OATS workspace model. The module contracts the kernel is built
against are in
[design/2026-09-23-workspace-module-contracts.md](design/2026-09-23-workspace-module-contracts.md).

## The rule

**Every capability an instance runs is copied whole into that instance at
spawn. A capability comes from one of two kinds of source; only one kind is
versioned.**

| Source kind | `from:` | Versioned | Trust |
|---|---|---|---|
| Member repo | `<repo key>` or `here` | no — always the member's **latest** default-branch state | membership (the reciprocal handshake) |
| Package | `package` | yes — the version pinned in the workspace's `packages:`; `oats-lock.json` records the exact commit + integrity | the declaration in `packages:` (no separate approval) |

A soul names each capability **with where it comes from — a location, never a
version**. The workspace's `packages:` says which version; materialization
*records* the exact state (repo or package, commit, content digest) in the
instance's `instance.json`. Resolution is a handshake check plus a lookup —
never a search.

Nothing is installed. There is no installed-capability directory, no activation
step, no `oats install`/`use`/`init`/`restore`. A fetch cache may exist under
the OS cache directory as invisible plumbing; no file refers to it.

## The files

Four declaration files and one lock. Three of them are shared through Git
(`oats-workspace.yaml`, `oats-membership.yaml`, `soul.yaml`); one is per
machine (`oats-local.yaml`); the lock (`oats-lock.json`) sits beside
`oats-local.yaml` and is identical on every machine that synced the same
workspace commit. Schemas: [`oats-workspace.schema.json`](oats-workspace.schema.json),
[`oats-membership.schema.json`](oats-membership.schema.json),
[`soul.schema.json`](soul.schema.json), [`oats-local.schema.json`](oats-local.schema.json);
the lock's format is in [packages](packages.md#lock-v3). The JSON schemas encode
shapes; domain rules (labels that are shared teams, duplicate members, canonical `from:` keys,
the two `packages:` value forms) live in the kernel's `validateWorkspace` /
`validateSoul`, which are the authority.

### `oats-workspace.yaml`: the one shared declaration

Lives in the repository that **hosts** the workspace (often a dedicated
`agents` repo, but any member can host it). One per organisation.

```yaml
schemaVersion: 2
name: acme

members:                                   # repo refs, NO @revision (E_WORKSPACE_SCHEMA)
  - git:github.com/acme/agents             # the host is a member too — it backlinks like any other
  - git:github.com/acme/platform
  - git:github.com/acme/tools              # a member that ALSO publishes a package (see below)

packages:                                  # the ONLY versioned things
  oats.framework: v1.22.1                  # bare version → resolves through the official catalog
  oats.okf: v5.8.0
  acme.tools: git:github.com/acme/tools@v0.4.0   # outside the catalog → git:<repo>@<tag|OID>; still a package

teams:                                     # SHARED teams: the same provider team for everyone
  engineering: { description: Platform and release automation, team: "engineering:acme.aweb.ai" }
  reviewers:   { description: Code review }   # declared, not created yet (no `team` id): readiness team-unmapped
defaultTeam: engineering                   # the workspace's default team; see Teams below
souls:                                     # which teams each soul may join besides its default
  platform/*: { teams: [reviewers] }

defaults:
  capabilities:
    oats.core: { from: package }
    acme-house-style: { from: github.com/acme/agents }   # a CANONICAL repo key: host/path, no scheme, no .git
  knowledge: { oats.okf: { from: package } }             # one slot default at most; a soul may say `none`
  messaging: none
  tasks: none

stores:                                    # knowledge stores, declared once
  org: git:github.com/acme/knowledge

messaging:                                 # an opaque provider payload for the messaging slot
  private: per-human
tasks:                                     # the same, for whichever capability fills the tasks slot
  team: engineering                        # (ignored while the slot is empty, as here unless a soul fills it)

external:                                  # souls borrowed from NON-members; revision REQUIRED
  - source: git:github.com/oss-collective/experts@9c4e1f2a9c4e1f2a9c4e1f2a9c4e1f2a9c4e1f2a
    soul: souls/security-reviewer
```

Refused by the schema: absolute filesystem paths as values anywhere (host state
belongs in `oats-local.yaml`), `@revision` on members, unknown top-level keys.
A `from:` value is `package`, `here` (souls only) or a **canonical repo key**
exactly as the kernel spells it (`parseRepoRef(ref).key`: lowercase host,
`org/repo`, no scheme, no `git:`, no `.git`; `local/<abs-path>` for a
file/bare-directory remote). Any other spelling is a schema error at
validation, not a late membership error.

### `oats-membership.yaml`: the backlink, in every member

```yaml
schemaVersion: 2
workspace: git:github.com/acme/agents      # "I am a member of acme"
```

Nothing else: there are no export lists, and team membership is local to each
deployment ([Teams](#teams)).

### `souls/<name>/soul.yaml`: where each capability comes from

```yaml
schemaVersion: 2
name: release-manager
description: Cuts, verifies and announces releases.
work: worktree                             # worktree | checkout | directory | workspace

capabilities:
  acme-release-tooling: { from: here }     # `here` = the repo this soul.yaml lives in
  acme-deploy: { from: package }           # provided by acme.tools, pinned in packages:
  acme-house-style: off                    # removes a workspace default

knowledge:                                 # provider payload, opaque to the kernel: the slot capability's settings
  harvest: off                             # (what this soul owns and reads is in souls/<name>/okf.json, not here)
messaging:
  channels: [acme-eng]
tasks: none                                # empties the slot

compatibility:                             # optional FLOORS on package versions: constraints, not sources
  oats.okf: ">=4.0"
```

Beside it: `AGENTS.md` (canonical), `CLAUDE.md → AGENTS.md`, `skills/`, and
whatever the slot providers read from the soul directory. For `oats.okf` that
is **`okf.json`** (`{ version: 1, owner, owns: ["<base>/<node>"], reads: […] }`),
the soul's knowledge declaration; it travels with the soul into the per-commit
soul cache ([knowledge.md](knowledge.md)). A slot payload on `soul.yaml` reaches
the provider as `OATS_SETTINGS` and may carry only the settings the provider's
manifest declares; the provider refuses any other key.

Every `souls/*/soul.yaml` in a member is listed and spawnable; souls have no
private mode. A soul's `name` must equal its directory name; the first of two
souls declaring one name (by path) is listed, the second is a problem.

### `capabilities/<name>/oats.json`: the manifest

The capability manifest is described in [capabilities.md](capabilities.md).
Discovery relies on `capability` (the same
`^[a-z0-9][a-z0-9._-]*$` grammar every `capabilities:` key uses), `version`,
`layer`, and may read `private: true` (a **repo-owned** capability). `version` is
informational for member capabilities — a materialized copy is identified by
its content digest.

### `oats-local.yaml`: the only per-machine file

Which workspace this machine realizes, where member clones live, host-owned
provider settings, this deployment's local teams and default (where the
workspace allows them), host
facts for automations, and launch configurations. The full reference is
[configuration.md](configuration.md).

### `oats-lock.json`: lock v3

Written by `oats sync`; the only persisted state at the deployment besides
`oats-local.yaml`. See [packages.md](packages.md).

## Repository references in diagnostics

Kernel call sites select the display context explicitly: `displayRepoRef`
for selected reference values, `displayDiagnosticText` for kernel-authored
diagnostic prose and `scrubGitLine` for Git's own lines. The entry points
share one private renderer; options on the first two cannot select Git-line
handling. The [development reference](implementation.md#remote-diagnostic-display)
documents their signatures and direct-module use.

Selected repository references in diagnostics are display values. A selected
original refused reference is shown verbatim when it is 1–256 characters long
and contains only ASCII letters, digits, spaces, `.`, `_`, `/`, `+`, `-` and
`:`. This bounded plain-value rule tests the whole original string: no trimming,
decoding, control-character removal or truncation makes a value eligible.
Plain-reference recognition is not a secret detector: credential-like text
that meets this alphabet remains visible. Otherwise, display is constructed
from recognised components.
An unambiguous scheme or scp-style reference supplies only its scheme, host,
supported port and path, using the repository parser's character rules. User
information is never a display component: `ssh://git@host/org/repo` and
`git@host:org/repo` both display as `ssh://host/org/repo`. Display recognition
can also remove user information from a well-formed HTTP(S) URL that the
repository parser refuses; it does not admit that URL for use by Git.

**The fixed withheld display is `[repository reference withheld]`.** It replaces
the whole selected value when neither the bounded plain-value rule nor
unambiguous component construction applies, including malformed or mixed
references outside the plain rule. Harmless host or path text in that value
is withheld too. A literal input equal to the fixed display looks the same;
the display is not an identifier or a value to pass back to a command.
Standalone `file:` references and filesystem paths retain their path meanings.

A diagnostic field that explicitly carries a pinned source uses the same
constructor with pinned-source context: a recognised reference followed by `@`
and a validated 40-hex-character commit can retain that commit in its display.
If either part cannot be recognised, the whole source is withheld: pinned
sources have no bounded plain-value fallback. `displayRepoRef` selects this
context with `pinned: true` for a complete `<ref>@<commit>` value, or with
`pinned: { ref, commit }` for its original components; both forms validate
both parts strictly. Rendering an already constructed pinned source does not
change it. Ordinary reference rendering does not infer a pin or admit a new
source form. Local/file reference semantics and operational external-source
values remain unchanged.

The same decision applies to the selected reference in error messages,
`details.ref`, `details.url`, `details.value`, `provenance.value`, nested
reference keys and values, and reference-bearing workspace and soul schema
problems. Discovery problem rows' `source` is also a diagnostic display.
Seven explicitly rejected argument fields have a separate context in the same
renderer: `transport`, `commit`, `at`, `path`, `depth`, `limit` and `destDir`.
A rejected string is preserved only when the whole original string satisfies
the same bounded plain-value rule above, including its space and colon
characters. No trimming, decoding, control handling or truncation is applied
to establish eligibility.
**The fixed rejected-value display is `[value withheld]`, and its neutral explanation is “(the value was withheld)”.**
Every other rejected string uses that display in the quoted message value and
matching details/provenance. Existing nonstring and container handling is
unchanged; nested strings use this same context. The renderer owns the
explanation once per originating refusal. This is a bounded display rule, not
a secret detector: a plain token made only of the permitted characters is not
protected. Selection belongs to the particular rejection; a field's name
alone never selects it. Valid argument values and other operational values
remain exact; pinned-source, schema and Git-line contexts keep their own rules.
Quoted or JSON-escaped copies and host/path fragments derived from a withheld
value cannot reveal its remainder. A raw host/path fragment can use the plain
exception only when its original selected source qualifies for that exception;
a fragment from a nonplain original never becomes eligible merely
because the fragment looks plain. Unrelated schema values and opaque provider
payloads are not scanned. Query and fragment contents are not searched for
individual secret values; a selected remote reference with an unrecognised
suffix outside the plain rule is withheld as a whole.

A refusal retains its code and reason. When the whole reference is withheld,
the kernel message explains that once per originating refusal. When a
constructed display omits user information, the refusal carries the neutral
clause “(its user information is not shown)”. An HTTP(S) userinfo refusal keeps
its specific cause and advice to give credentials to Git through a credential
helper, rather than in the URL; package refusals keep their own reason.
Workspace and membership message slots carry an existing refusal's explanation
when they forward it, including schema `problems[].message`, without adding
another copy. Pattern-only schema problems use the same selected-value display
without inventing a parser refusal. Known declaration files and key locations
remain available beside the safe diagnostic value; APIs that do not know a
location do not invent one.

Git's own diagnostic text has a whole-line disclosure rule. A line may be
shown only when every original operation reference is known and unchanged by
the display constructor, and the original line contains no literal `@`.
Missing original-reference evidence fails that check. Check the original text
before removing control characters or shortening the line; formatting must not
hide a reason to withhold it. A permitted line keeps the existing control
handling and length bound.

For an unknown Git failure, the last-line diagnostic comes only from stderr.
Empty or whitespace-only stderr leaves the message at the failure reason;
there is no error-message fallback on this route. An output overflow without a stderr line uses a
kernel-owned budget notice. Other diagnostic routes that already use an error
message fallback keep their behavior and the whole-line disclosure rule.

**The fixed Git notice is “Git's diagnostic was withheld; run the same Git operation by hand to see Git's own words.”**
Every other Git line is replaced by that notice. No substring or token is
recovered from a withheld line. This replaces the quoted-line disclosure rule
shipped with the unknown-failure diagnostic: a bounded, scrubbed fragment alone
is no longer enough to display Git's words. Classification still reads Git's
result, so the failure code and reason remain useful when its text is withheld.
Kernel-owned messages and schema problem prose keep their selected-reference
rendering; they are not Git lines. Transport failures do not gain a
repository-refusal clause.

These diagnostic fields are for people. Accepted parser results, repository
identity keys and other values consumed by commands remain exact, including
operational `from` values and external rows' `source`; so does the original
reference handed to Git. Diagnostic rendering changes neither the
accepted syntax nor transport. A client may extract a host from a constructed
display; it must also handle the fixed withheld display without a host.
Desktop's external-soul view still displays the operational external `source`
value directly; that separate output route is tracked in
[#1111](https://github.com/awebai/oats/issues/1111). The diagnostic display rule
does not make that raw consumer safe.

## Membership and trust

**Reciprocal membership is a hard gate.** A repo is a member only when
`oats-workspace.yaml` lists it **and** the repo's `oats-membership.yaml` names
the workspace back. One file per side; a copied backlink in a fork, or a folder
with the right name, is not admission.

**Membership is the whole trust decision for member capabilities**, the same
model as a repo's committed `.agents/skills/`: whoever can push to the repo
decides what runs, and the branch's latest state is what runs. Packages come
from *outside* that boundary, and **declaring one in the workspace's
`packages:` is the trust decision** ([packages.md](packages.md#trust)). A spawn admits only a locked package the workspace
**still declares**: one removed from `packages:` but left in a stale lock is
`E_PACKAGE_MISSING { reason: "undeclared" }` until `oats sync` drops it.

**The handshake is observed with the operator's own Git read access, in one
access context.** The kernel reads both halves over the remotes
(`git ls-remote`, shallow fetches, the operator's own credential helpers,
never a prompt). A half that cannot be read makes the member *unconfirmed*,
never a half-success. A remote's current head is read with Git's protocol v0
(one round trip) unless your Git configuration sets `protocol.version`, which
is then used as set; a tag or branch is read as before. A remote whose v0 ref
advertisement is over 4 MiB is read with protocol v2 from then on: the 4 MiB
bounds what OATS keeps, not the download, so the first read transfers that
advertisement once before falling back. A remote that times out under v0
fails as before and is read with protocol v2 for the next 7 days; a read
ended by the 12 s budget of `oats status` or `oats workspace status` is not
the remote's own timeout, and is neither remembered nor warned about. One that
fails under v0 for another reason than an authentication refusal, a missing
repository or the local cache is read again with v2. Each case prints one
`oats: warning`; the first two are remembered in the remote cache. `oats workspace status` and `oats sync` show each member
as `confirmed` or the reason it is not:

| status | meaning |
|---|---|
| `confirmed` | listed and backlinks to this workspace |
| `not-listed` | the workspace does not list the repo |
| `no-backlink` | no (or invalid) `oats-membership.yaml` at the member's default branch |
| `backlink-elsewhere` | the member names a different workspace (a case-only difference is flagged: repo paths are case-sensitive identities) |
| `cannot-read` | the operator cannot read the member (auth / not-found / network / timeout / killed: the system killed git, e.g. out of memory / unknown: git failed for a reason the kernel cannot name), or this machine's remote cache could not be written (cache) |

An unconfirmed member contributes nothing but its row: its souls are invisible,
its capabilities unresolvable (`E_NOT_A_MEMBER` / `E_MEMBERSHIP_UNCONFIRMED`).
Reading the workspace repo *is* being in the workspace — a workspace's access
control is Git's.

**Git version failures preserve the remote cache.** Partial caches need Git
2.45 or later. A successfully parsed older version causes OATS to rebuild a
partial cache with whole trees. If the version command fails, times out or
returns an unparseable version, the read instead fails with
`E_REMOTE_UNREADABLE` and an existing reason (`unknown` for unparseable
output, `timeout` for a timeout). The partial cache, its fetch mode and its
commit pins are preserved, and a later read can retry the version probe.
This also applies to library reads without a session. A cache already using
whole trees stays in that mode when a later probe finds a newer Git.

**Repo-owned capabilities.** `private: true` in a capability's `oats.json`
makes it **repo-owned**: it is listed like any other capability (with
`private: true`; the human table marks it "(repo-owned)"), and it is usable
only by souls of the same repo (`E_CAPABILITY_PRIVATE` otherwise). Souls have
no private mode: every soul of a confirmed member is listed and spawnable.

**External souls.** `external:` adopts a soul by reference from a repo that is
**not** a member, pinned to a full commit. No handshake is asked for and none is
read; the soul gets no member-tier capabilities of its own repo; it is
"source-complete" (its skills travel with it) and the workspace's defaults fill
its slots.

**Package souls.** A package may ship souls (`souls:` in `oats-package.json`):
they are listed from the lock for each package the workspace declares,
named `<package>/<soul>` (a bare name when unique), resolved like any soul
(`from: here` = their own package at the locked commit) and trusted as the
package is. See [packages](packages.md#package-souls).

### Moved repositories

Seven repositories moved from the `awebai` organisation to `oats-project`:
`oats`, `oats-okf`, `oats-engineering`, `oats-cloning`, `oats-authoring`,
`oats-omarchy` and `oats-knowledge`. The kernel holds the table, and keeps it
for good, because old `oats-local.yaml` files, locks and homes name the old
keys.

**The old and the new key of a moved repository are one repository, wherever
a key is compared.** That covers the backlink check, `clones:`, a clone's
remotes, the key a home recorded at spawn, `from:`, a `git:` package source in
the lock, a server's `workspaceKey`, the keys given to `--member`, `--repo` and
`--workspace-key`, and a member's soul named `awebai/<repo>/<soul>` or
`oats-project/<repo>/<soul>`. The Desktop and the release lane's mirror check
compare the same way. So a workspace and its members can change
their strings in any order: a member naming the workspace by the other key
stays confirmed, and a home recorded under the other key keeps its drift rows.

**The kernel compares and never rewrites.** Every key stays as it was declared
or recorded: in each JSON answer, in the cache directories, in the lock and in
`instance.json`. A URL goes to Git as it is written; GitHub redirects the old
one. A deployment that changes no string behaves as it did before.

Only these seven are moved. Every other `awebai` repository keeps its key, and
a key that differs only by letter case is still a different key.

**The seven old names in `awebai` are never reused, and nothing is created at
them.** A repository at an old name, even one that only says "moved", ends
GitHub's redirect for that name for good, and the kernel would treat it as the
moved repository.

**The table is closed.** It has these seven entries, and there is no general
setting for moved repositories. An eighth entry needs a contract answer from
both sides of the move.

## Member tier vs package tier: the non-collapse rule

A repository may be a **member** (it completed the handshake; its `souls/*` and
`capabilities/*` are member-tier: latest state, trusted by membership) **and** a
**package publisher** (its `oats-package/` is consumed only through
`packages:`: versioned and locked). The two never collapse:

- `from: <repo key>` looks **only** under `<repo>/capabilities/<name>/oats.json`
  at the member's latest state. It never looks inside `oats-package/`. A name
  that exists only inside the repo's package fails with `E_CAPABILITY_MISSING`
  and the hint `provided by package <id>; use from: package`.
- `from: package` looks **only** in the lock (which package provides the
  capability). It never looks at member capabilities, even when the package's
  repo is a member.
- Discovery reports a member's `oats-package/` as `publishes: { package,
  version }` on the member row (informational) and does **not** list the
  package's capabilities as member capabilities.

A publisher that also keeps copies of its package's capabilities (a mirror, a
fixture) keeps them outside `capabilities/`, or discovery lists them as member
capabilities too: the same capability offered twice, once at latest state. The
`oats` repository keeps its mirrors of the official packages in `mirrors/`.

So the framework's own souls say `oats.okf: { from: package }` even though
`oats-okf` is a member of the OATS workspace, and every package repo carries a
member soul that is the expert in that capability (`oats-okf-expert`,
`oats-aweb-expert`, …), discoverable at latest state like any member soul.

## Packages, lock, catalog

`packages:` values have two forms, a **bare version** resolved through the
official catalog and a **`git:<repo>@<ref>`** direct ref; both are versioned
and locked, and a ref that resolves to a branch is refused. `oats sync`
confirms membership, resolves every entry to a commit and content digest,
writes `oats-lock.json`, creates `agents/` if absent and reports what changed.
`oats package add | remove` edit `packages:`. The grammar, the lock, trust and
the catalog are in [packages.md](packages.md).

## Resolution, spelled out

For each `(name, from)` in
`defaults.<slot>` ⊕ `defaults.capabilities` ⊕
`soul.capabilities` (later wins; `off` removes; a soul `<slot>: none` drops
the workspace's slot default):

```
from: package → some locked package provides `name`            else E_PACKAGE_MISSING (run `oats sync`)
              → read its manifests at the locked commit; the lock's capability list must match   else E_PACKAGE_INTEGRITY
              → copy; record package/version/commit/digest
from: <repo>  → <repo> is a CONFIRMED member                     else E_NOT_A_MEMBER / E_MEMBERSHIP_UNCONFIRMED
 (or `here`)  → it has capabilities/<name>/oats.json             else E_CAPABILITY_MISSING
              → not private, unless <repo> is the soul's own    else E_CAPABILITY_PRIVATE
              → copy from the member's current state; record repo/commit/digest

slots   a module whose manifest says `layer: X` fills slot X; two → E_SLOT_CONFLICT;
        a slot default must be a capability of that layer; soul `X: none` empties X
skills  duplicate names within the composed set → E_SKILL_DUPLICATE (names both capabilities)
floors  soul.compatibility.<cap> is checked against the package's version → E_COMPATIBILITY
```

The result is an immutable **resolution** with a `revision` (a hash of
everything above); the spawn decision binds it, so a member that moved between
preview and apply is `E_DECISION_STALE`, not a silent drift.

## Materialization and the instance home

At spawn every resolved capability is **copied whole** into the instance home
(skills, injects, scripts, hooks) from the remote at the recorded commit, and
`instance.json` records each module's source, commit and digest. Nothing is
symlinked or shared between instances, and a running instance never changes
under itself: a member moving or `packages:` being bumped affects only new
spawns. The home's layout and records are in
[souls-and-instances.md](souls-and-instances.md).

**Drift is shown, not prevented.** `oats status` compares each instance's
recorded modules — and its recorded **soul source** (`instance.json.workspace.soul`)
— with the workspace's current picture: `current`, `moved` (member or package
now at another commit) or `missing` (capability no longer present, member
unconfirmed, package no longer locked). The text form is `soul: <name> from
<member> @ <c7>  [member moved since …]` above the module rows; `--json`
carries `instances[].soul`. `oats spawn --preview` lists `changedSince` the
newest previous instance of the same soul, plus `providers` (the `--provider`
map as given) and `settings.<cap>` (the merged payload each provider receives).

Harnesses start normally, with their own skill discovery intact
([souls-and-instances.md](souls-and-instances.md)).

## Teams

A team is a messaging-provider team (for oats.aweb, an aweb team id
`<team>:<namespace>`) under a **label**. An instance that sits in two teams is
a bridge between them: one process reads both inboxes and could relay anything
from one to the other. So which teams an organisation's instances may be in is
the organisation's decision, committed in its workspace file and closed by
default; a deployment's `oats-local.yaml` adds a team only where the workspace
allows it. Souls stay team-free in their own repositories: an organisation
says how souls behave in its teams in its `oats-workspace.yaml`, and someone
running the same souls standalone sees none of it.

**What this protects against, and what it does not.** The workspace's team
rules prevent **accidental** joins in a cooperative installation, and they make
the organisation's intended team set visible and reviewable in its git. That is
all they claim. They do not stop an operator from bridging teams on purpose:
whoever holds credentials for two teams can read under one identity and relay
under the other, or copy content outside the messaging layer, and distinct keys
do not prove distinct processes. The messaging provider's admission (for aweb,
the team controller key signs memberships; hosted invites are mediated by the
service) controls who holds credentials for a team, not what a process does
with what it reads. A deployment's authority comes from the credentials it
holds, not from its path or its name, and a team certificate carries no soul,
workspace or home-team claim (such metadata would be self-asserted, not a
control).

### Where teams are declared

```yaml
# oats-workspace.yaml (committed, edited by PR)
teams:                                   # SHARED teams: the same provider team for everyone
  engineering: { team: "engineering:acme.aweb.ai" }
  security:    { team: "security:acme.aweb.ai" }
  docs:        { description: Docs rota }       # declared, not created yet: team-unmapped
defaultTeam: engineering                 # the workspace's fallback default team (a shared label)
localTeams: false                        # may deployments declare their own teams? (absent: false)
souls:                                   # per soul pattern: its default team and the other teams it may join
  "*": { teams: [] }                     # unlisted souls: default only (also what no entry means)
  security-souls/*: { default: security, teams: [engineering] }
  security-souls/incident-responder: { default: security, teams: [engineering, docs] }
  oats.engineering/*: { teams: any }     # any: every shared team of this file
```

- **Shared teams** (`teams.<label> = { description?, team? }`): a shared team
  without `team` is declared but not created yet (readiness `team-unmapped`):
  its owner creates it with the messaging provider, then commits the id.
- **`souls:` keys are patterns**: `<member>/<soul>` or `<package>/<soul>`,
  `<member>/*` or `<package>/*`, and `"*"`, with the member and package names
  `souls.disabled` uses (a member's name is its repository's). A bare soul name
  is refused. A key that is neither a pattern nor a soul the workspace offers
  is the warning `team-soul-unknown` (a typo guard).
- **The most specific key wins outright** for a soul's teams, and lists never
  merge: the soul's own key, then `<member|package>/*`, then `"*"`. The
  default comes from the most specific key that sets one. So
  `a/*: {default: security}` and `a/x: {teams: [docs]}` give `a/x` the default
  `security` and the teams `[docs]` only.
- **A soul no key matches** (and no `"*"`) has its default only. That applies
  to member and package souls alike: a workspace opens a package explicitly.
- **Every label** (`defaultTeam`, each `default`, each of `teams`) must be a
  shared team of the same file; anything else is `E_WORKSPACE_SCHEMA` when the
  file is read, never at a spawn on someone else's machine.
- **Local teams** (`oats-local.yaml` `teams.<label> = { team, description? }`)
  and a local `defaultTeam` are allowed only when the workspace says
  `localTeams: true`. Otherwise every spawn, preview and inspect is refused with
  `E_WORKSPACE_SCHEMA` (reason `local-teams-closed`), naming both fixes: add
  `localTeams: true` to the workspace file, or commit the teams and the
  default there and remove them locally. A label in both files is
  `team-label-collision` (a warning): the **shared** definition wins, and the
  fix is renaming the local label.
- **The standalone view** (an explicit `standalone:`, or a fallback when the
  workspace cannot be read) has no workspace rules: local teams and the local
  `defaultTeam` apply there.
- `soul.yaml` and `oats-membership.yaml` say nothing about teams.
  `oats-local.yaml` `souls.teams` and `souls.default` were removed in 0.38.0:
  they are refused, and the refusal prints the `souls:` to commit instead.

### A soul's default team and its teams

The default, in order:

1. the soul's `default` from `souls:` (the most specific matching key that
   sets one);
2. else the deployment's `oats-local.yaml` `defaultTeam`, only when
   `localTeams: true`;
3. else the workspace's `defaultTeam`;
4. else none (`E_TEAM_UNCONFIGURED` when a messaging layer is active).

`defaultTeam.from` says which: `soul`, `deployment` or `workspace`.

The teams a soul may join: its default, plus the `teams` of its most specific
matching `souls:` key, plus, with `localTeams: true`, every local team the
deployment declares. Each row says why (`via`: `default`, `workspace`,
`local`). At spawn an instance joins its **default** only; the others are
eligible: offered, and joined on request through the provider (`join=` at
spawn, or its own verbs later), which refuses a team that is not eligible.
A local default no file declares is `E_TEAM_UNKNOWN`. Capabilities compose
from the workspace defaults and the soul only, the same for everyone. **A
label never gates, restricts, changes trust or partitions the knowledge
store.**

### The verbs

They never call a provider. `oats teams add` and `oats teams default` edit
`oats-local.yaml` in place, where the workspace allows local teams; `oats teams
remove` runs anywhere (removing local teams is how a deployment moves them into
the workspace). A soul's teams are edited by a PR to `oats-workspace.yaml`:
`oats soul teams` only reads them.

```
oats teams [--json]                                  # the teams, ids, the default, localTeams, the workspace's souls:, problems
oats teams add <label> --team <id> [--description d] # declare a local team (the first one becomes the local default)
oats teams add <label> --team <id> --no-default      # the mapping only; the same label and id again is reuse
oats teams remove <label>                            # refused while it is the local default (E_TEAM_IN_USE) or shared (E_TEAM_SHARED)
oats teams default <label>                           # the local default
oats teams default <label> --if-absent               # ... only where there is no effective default
oats teams default <label> --expect <label0>         # ... only where the effective default is <label0>
oats soul teams <soul>|'*' [--json]                  # a soul's default and teams here, and which souls: key gave them
```

`--if-absent` and `--expect` make a setup safe to run against a deployment
whose default it has not chosen: the condition is the effective default that
`oats teams` reports (the local one, else the workspace's), judged when the
file is written, and a failed one (`E_TEAM_DEFAULT_MISMATCH`) reports what it
found and writes nothing. A soul's `souls:` default is not the deployment's
default and is not looked at. Concurrent `oats teams` writes on one deployment
are serialized, so of two racing conditional writes the later one refuses;
hand edits to `oats-local.yaml` and changes to `oats-workspace.yaml` are not
serialized with them. Each form refuses a flag it does not take (`E_USAGE`).
Callers check for the feature `teams-conditional-default` in `oats version
--json` first: an older kernel ignores these flags.

The messaging provider's own setup creates provider teams (see the provider's
documentation). The spawn preview, `inspect` and `oats souls` report a soul's
`teams` and `defaultTeam`; readiness reports the team problems in
`checks.configured` (`E_TEAM_UNCONFIGURED` when a messaging layer is active and
there is no default; `team-unmapped`, blocking when it is the default;
local-teams-closed; `team-soul-unknown`; `default-team-changed` for a running
instance). The provider receives them in its environment — see
[capabilities.md](capabilities.md#teams-in-the-provider-environment). Exact
shapes: [desktop-cli-api.md](desktop-cli-api.md#team-model-3-feature-team-model-3-oats-0370-replaces-feature-team-model-2).
Why it is shaped this way: [team model 3](design/2026-10-02-team-model-3.md).

## Provider payloads have three homes

| What it is | Where | Example |
|---|---|---|
| True of every instance of the soul | `soul.yaml` → `knowledge:` / `messaging:` / `tasks:` | `messaging: { channels: [acme-eng] }`; `knowledge: { harvest: off }` |
| A fact about this machine | `oats-local.yaml` → `settings.<cap>.<key>` (absolute paths are refused in the workspace file) | `settings.oats.okf.state-dir: /Users/ana/.oats/okf` |
| A fact about **this spawn** | `oats spawn … --provider <cap> key=value` (repeatable; dotted keys nest) → `instance.json.providers.<cap>` | `--provider oats.aweb identity.source=/abs/path/to/retained/.aw` |

The merged payload is the manifest's setting defaults ⊕ the workspace's
`messaging:` (for the messaging-slot capability only) or `tasks:` (for the
tasks-slot capability only) ⊕ soul slot payload ⊕ `local.settings[cap]` ⊕
`spawn.providers[cap]` — objects deep-merge, later wins on scalars and arrays.
There is no workspace `knowledge:` payload. A workspace `tasks:` needs a kernel
with the feature `workspace-tasks-payload`: an older one refuses the file
(unknown property). The provider's own `binding` contract (its readiness
check) runs over the merged payload.

A capability's manifest may pin a setting to one of these layers. A key it
marks `hostOnly` comes only from `oats-local.yaml`; a key it marks
`committedOnly` never comes from `oats-local.yaml` or `--provider`: it is set
in the workspace's `messaging:` or `tasks:`, a soul's slot payload, or left at
the manifest default, so every deployment shares one value. Either one set in
the wrong layer is refused (`E_WORKSPACE_SCHEMA`, reason `host-only-key` or
`committed-only-key`), naming the key, where it was set and where it may be set
([Commands and hooks](capabilities.md#commands-and-hooks)). Teams are **not** settings:
they reach the provider beside them, in its environment ([Teams](#teams)).
Where a provider keeps its own state (for oats.aweb, its identity roots) is the
provider's concern; see its documentation.

A store (`stores: { <name>: <repo ref> }`) names a repository; where a
knowledge base lives inside it is the knowledge provider's own concern. For
oats.okf that is the **bindings file** (`bases.<alias>.repository` + `root`,
`oats-local.yaml settings.oats.okf.bindings-file`), not a soul payload key; a
repo ref never carries a `#path`.

`--provider` for a capability the soul does not resolve is `E_CAPABILITY_MISSING`;
`__proto__`/`constructor`/`prototype` as a key at any depth is refused.

## Discovery over remotes and the deployment directory

Discovery and resolution work against **Git remotes, never local clones**. The
kernel fetches `oats-workspace.yaml`, each member's `oats-membership.yaml`,
every `souls/*/soul.yaml` and `capabilities/*/oats.json`, and every package by
URL — with the operator's own git configuration (`GIT_TERMINAL_PROMPT=0`, ssh in
BatchMode: nothing ever prompts). Neither the repo that defines a capability nor
the repo that hosts the workspace needs to be cloned.

`oats souls` and `oats capabilities` print every catalog discovery problem
below their tables on stdout, in the same order as `--json` `problems`.
`oats souls` adds unmatched `souls.launch` keys after discovery problems.
Each line preserves `! <code>: <message>`. When the problem has an owner,
a bracket identifies its path and, where present, repository key or package;
external problems show their [diagnostic source display](#repository-references-in-diagnostics)
and declaration path, while operational external sources remain exact. These listings still exit 0
when some items cannot be read. A diagnostic can also describe an item that
remains listed; inspect its code and message.

**The only thing that needs a clone is a soul's work target** (`work:
worktree | checkout`). The kernel finds it, first hit wins: (1) `oats spawn
… --repo <abs path>`; (2) `oats-local.yaml` `clones: { <repo key>: <abs
path> }` (keys are canonical repo keys — any ref spelling is normalised through
`parseRepoRef`); (3) the convention `<deployment>/<member name>` (the last
segment of the repo key; a member named `agents` is looked for at
`<deployment>/agents-repo`, since `agents/` is the instance root). None →
`E_CLONE_MISSING` naming the three remedies; a directory whose `origin` is a
different repo → `E_CLONE_MISMATCH`. Spawning a soul whose repo is not yet
cloned is a guided clone-then-spawn, a job for the onboarding skill, not the
kernel.

The deployment directory is **yours to choose**: an existing folder that already holds your member clones is the usual case, and `oats onboard <dir>` adds what the kernel needs and nothing else ([configuration.md](configuration.md#the-deployment-directory)):

```
~/acme/                           ← the directory you chose
├── oats-local.yaml               ← which workspace this machine realizes, and host facts
├── oats-lock.json                ← exact commit + integrity per package
├── agents/                       ← instance homes (each self-contained) + fetched soul sources
├── platform/                     ← clone of github.com/acme/platform (only if someone works IN it; may live elsewhere — see clones:)
└── tools/
```

The kernel never depends on this shape: `oats-local.yaml` is found by walking
up from the current directory (`E_LOCAL_MISSING` otherwise); `agents/` is
created by `oats sync` when absent; clones are found through `--repo`,
`clones:` or the convention, in that order. A soul that lives in a member repo
is fetched into `<agents-root>/<soul>/souls/<commit12>/` at its discovered
commit before its first spawn (idempotent per commit; `<agents-root>/<soul>/soul`
points at the current one); its instances then materialize as above.

## This computer's deployments

Most people have several deployments, and one computer can hold two
deployments of the same workspace. The kernel keeps **one per-user list of the
deployments on this computer**, `~/.oats/config/deployments.json`
(`OATS_HOME_DIR` overrides `~/.oats`). The clients (the Desktop, the TUI) read
it to offer the deployments that are not open, and `oats deployments` shows it.
It lists local deployments only: other machines stay in the
[server registry](servers.md).

**The file** (mode 0600, in a `config/` directory with mode 0700) holds facts
only. Which deployments a client has open stays with that client.

```json
{
  "schemaVersion": 1,
  "deployments": [ { "path": "/home/me/acme", "addedAt": "2026-10-19T10:00:00.000Z", "via": "onboard" } ],
  "imports": { "agents-dir": "2026-10-19T10:00:00.000Z" }
}
```

- **`path`** is absolute and canonical, and unique in the list: the directory
  as it is on disk (a link, or another letter case on a case-insensitive
  filesystem, is one row), then the primary checkout's path when the
  deployment sits in a linked Git worktree.
- **`via`** says how the row joined, for information only: `onboard`, `tui`,
  `desktop`, `cli`, `import:agents-dir` or `import:desktop`.
- **`removed: true`** and **`removedAt`** mark a row `oats deployments remove`
  took out (below). Nothing shows it.
- **`imports`** holds the one-time migration markers; a missing key means that
  import has not run.

**What lists a deployment:**

- `oats onboard`, on success, lists what it created (`via: onboard`). Its
  result says so in `listed`: `true`, or `{ code, message }` when the list
  could not be written. A failed add never fails the onboard; `--check` lists
  nothing.
- `oats deployments add [<dir>]`, which the clients run when they open a
  deployment, and people by hand. It lists the deployment at or above `<dir>`
  (default: the current directory): the nearest directory whose
  `oats-local.yaml` is a regular file, not a link. A directory or a link of
  that name is not a deployment's file and is passed over.
- **Every kernel command that resolves a deployment that is not listed yet**
  lists it (`via: cli`): `status`, `spawn`, `sync`, `session`, `doctor`,
  `retire` and the others that read a local deployment, from inside an
  instance home too. The deployment is the one the command itself resolved
  (its canonical root, when it resolves one), checked once per process, as it
  ends; a command that resolves none (`version`, help, a command
  refused before it reads a deployment) checks nothing.
  - A listed deployment costs one read of the list (at most 1 MiB, no lock),
    compared with the path the command resolved: no lock, no write, no
    process. Measured on `oats status --json`, that is about 0.5 ms the first
    time in a process.
  - Another spelling of a listed deployment (a link, or `/var` for
    `/private/var` on macOS) costs a realpath too. Only an unlisted
    deployment goes further: its canonical path, then one try of the lock. When the lock is free it re-reads and writes once; when
    it is busy the add is skipped at once, and the next command tries again.
  - It is best effort and silent: nothing is printed, and the command's
    answer and exit status are the same whether or not it listed anything.
  - A command routed with `--server` never lists anything: the host's path is
    not this computer's.
  - A deployment under a temporary directory (`os.tmpdir()`, `/tmp`,
    `/private/tmp` or `/var/folders`, each compared after realpath) is never
    listed this way, since test fixtures live there and would stay in the list
    as `missing`; `oats deployments add`, `oats onboard` and a client opening it
    still list one.
  - A deployment inside a linked Git worktree or submodule is listed by the
    first command that resolves its instance root (`status`, `spawn`,
    `session` and the like), not by `sync`, `doctor` and the other
    configuration commands.

**Removing.** `oats deployments remove <path>` takes the row whose stored path
is `<path>` (it does not walk up, so a row whose directory is gone can be
removed) and touches nothing on disk. The row stays in the file as a
tombstone, so nothing automatic lists that path again: not a plain command,
not an import. An explicit `oats deployments add`, an `oats onboard`, or a
client opening the deployment by its path brings it back.

**The first use imports `~/Agents`, once.** The first command that touches the
list (any of the above) reads `$HOME/Agents` under the list's lock: at most 200
entries, no link followed (`~/Agents` itself included). Every directory there
that holds a regular, non-link `oats-local.yaml` is listed
(`via: import:agents-dir`), and `imports["agents-dir"]` is set, even when
`~/Agents` is missing or empty. After that nothing reads `~/Agents` again. A
command whose import could not run (`~/Agents` cannot be read, the lock is
busy, the write fails) fails: it never answers a list that skipped it, and
nothing is marked. A single entry inside `~/Agents` that cannot be checked is
skipped.

**The Desktop's own lists** are imported once by
`oats deployments import --from desktop <path>...`: the first run lists every
absolute path given, whatever its state, and sets `imports.desktop` in the
same write; every later run changes nothing.

**Each row's state** comes from existence checks only; no deployment's content
is read:

| State | Meaning |
|---|---|
| `ok` | the directory holds a regular, non-link `oats-local.yaml` |
| `missing` | the path is gone, or on a volume that is not mounted |
| `not-a-deployment` | the path exists, without an `oats-local.yaml` |
| `unreadable` | the check failed (for example `EACCES`) |

```
$ oats deployments
PATH        STATE    VIA
~/acme      ok       onboard
~/old-demo  missing  import:agents-dir
```

**Concurrency.** Every change runs under `~/.oats/config/deployments.lock`
(waiting up to 3 s for it) and re-reads the file inside it, and each write
replaces the file atomically. Readers take no lock: they read a regular file
only, without following a link, up to 1 MiB. A missing file is an empty list.

**Errors:**

| Code | When |
|---|---|
| `E_DEPLOYMENTS_INVALID` | the file is not JSON, not an object, a link, over 1 MiB, or a row breaks the schema: "`<file>` cannot be read as this computer's deployments list (`<reason>`). Fix it, or move it aside and run `oats deployments add <dir>` for each deployment; nothing was changed" |
| `E_DEPLOYMENTS_VERSION` | `schemaVersion` is newer than this oats reads: "`<file>` was written by a newer oats (schema `<n>`); upgrade oats". The file is never rewritten down |
| `E_DEPLOYMENTS_BUSY` | the lock is still held after 3 s: "this computer's deployments list is locked (`<why>`); if no oats process is changing it, remove `<lock>` and retry; nothing was changed" |
| `E_DEPLOYMENTS_WRITE` | the write failed, or would make the file larger than 1 MiB: "cannot write `<file>` (`<system error>`); nothing was changed" |
| `E_DEPLOYMENTS_IMPORT` | `~/Agents` cannot be read for the first-use import: "cannot read `<dir>` to import its deployments (`<system error>`); make it readable, or move it aside, and retry; nothing was changed" |

`oats deployments add` outside every deployment is `E_LOCAL_MISSING`. The
JSON of each verb is in the
[Desktop CLI API](desktop-cli-api.md#this-computers-deployments-oats-deployments).

## The standalone case

A repo you can read whose workspace you **cannot** read (a contractor with
access to `platform` but not to the private `agents` repo) still offers its
souls: their `from: here` capabilities resolve; `from: <other member>` and
`from: package` are unresolvable (the version list lives in the workspace
file); workspace defaults do not apply because they cannot be seen. This is the
workspace's access control working, not a degraded mode to paper over: make
the host repo readable (it holds declarations, no secrets) or grant access.

Two things keep the standalone spawn useful rather than hollow: `oats.core`
(the framework's own operational package) is the kernel's default here as
well, resolved from the official catalog through the operator's own lock like any
package (a soul may say `oats.core: off`); and the
operator's `oats-local.yaml` may name the repo directly (`workspace: <member
ref>` — the kernel notices it is a member whose workspace it cannot read and
falls back to the standalone view — or `standalone: <repo ref>` to ask for
that view explicitly). `oats onboard` lists the host among the clones to make
like any member (the host is a member; its souls may need a work clone); under
an explicit `standalone:` header its next steps say so and name that one repo.

**Executables from public members.** Membership is the trust: a
member capability's hooks and command scripts run on every operator's machine at
spawn, gated by nothing but the handshake. In a mixed public/private
organisation keep **souls only** in public members and let executable
capabilities come from packages (declared in `packages:`, pinned by the lock)
or from private members.

**Hosting the workspace file when some members are private.** Everyone who
can read the workspace file sees the member list. So: a public member never
hosts it when any member is private (it would publish the private repo's
name); the private member hosting it hides the workspace from public
contributors, who then live in the standalone case above. A dedicated private
repo (`<org>/workspace`) is the honest shape for a mixed organisation; the
onboarding skill asks this question first.

## What is deliberately not versioned

- **Members.** A member is always its latest state; there is no `@revision`
  on `members:`. A team that wants frozen capabilities publishes them as a
  package and pins that.
- **Member capabilities' `version` field**: informational; the content digest
  recorded at spawn identifies a copy.
- **Souls in members.** A soul is spawned from its repo's current state; the
  commit is recorded in `instance.json.workspace.soul`.
- **The deployment layout**: the operator's; only the convention is taught.

What **is** versioned: `packages:` (the workspace's one list), the lock's exact
commits and digests, and `external:` pins (a stranger's repo is never "latest").

## Related

- [Souls and instances](souls-and-instances.md) · [Packages](packages.md) ·
  [Configuration (`oats-local.yaml`)](configuration.md)
- [Capability manifests](capabilities.md) · [Contracts](layers.md) ·
  [Desktop CLI API — workspace model](desktop-cli-api.md#workspace-model-workspaceapi-2)
- [Design navigation](design/README.md)
