# Workspace model: module contracts

**Status:** normative for `lib/remote.mjs`, `lib/workspace.mjs`, `lib/resolve.mjs`, `lib/packages.mjs`,
`lib/materialize.mjs` and the CLI verbs built on them. When this record and a reference page
(for example [workspaces](../workspaces.md) or [packages](../packages.md)) disagree about
operator-visible behaviour, the reference page wins.

Conventions: ESM, Node 22+, no runtime dependency beyond `yaml` and `node:*`. Errors are
`oatsError(code, message, details)` with stable `E_*` codes. Commits are full 40-hex OIDs, digests
`sha256-<hex>`. Only `lib/remote.mjs` (to `git`) and the launch path shell out. Modules that read a
remote take `{ remote, remoteOptions }`: `remote` defaults to `lib/remote.mjs` (tests inject a fake);
`remoteOptions` (`cacheDir`, `exec`, `transport`) reaches every remote call.

---

## 1. `lib/remote.mjs` — observe Git remotes in the operator's access context

### 1.1 Repo refs and keys

`parseRepoRef(text, options?) → { host, path, url, key }` or `E_REPO_REF`. Accepted forms:
`git:host/org/repo`, `https://host/org/repo`, `git@host:org/repo.git`, `ssh://[user@]host[:port]/org/repo`,
`/abs/bare.git` and `file:///abs/path`. The fetch `url` keeps SSH forms as written, canonicalizes HTTPS,
and fetches `git:` over HTTPS unless `options.transport === "ssh"`.

`key` is the identity everywhere: `<host>/<path>` with a lowercase host, no scheme, no `.git`; a local
remote's key is `local/<abs-path>`. Modules compare keys, never URLs. The path part is case-sensitive.

### 1.2 Reads

```js
observeRemote(ref, { at })                          // → { key, url, commit, ref, observedAt }
readRemoteFile(ref, commit, path)                   // → { bytes, size }
listRemoteTree(ref, commit, dir, { depth = 2 })     // → [{ path, type: "blob"|"tree"|"symlink", size? }]
fetchRemoteTree(ref, commit, dir, destDir, { allowSymlinks }) // → { files, bytes, digest }
contentDigest(dir, { allowSymlinks })               // → "sha256-<hex>"
```

- `observeRemote`: `at` absent or `HEAD` is the default branch; else a full OID or a plain tag or branch
  name (revision syntax or a leading `-` is `E_REPO_REF`). `commit` is always the peeled commit. No match,
  or a non-commit object, is `E_REMOTE_UNREADABLE { reason: "not-found" }`.
- `readRemoteFile`: missing or a directory → `E_REMOTE_PATH_MISSING`; a symlink →
  `E_REMOTE_TREE_UNSAFE { why: "symlink" }`; over 4 MiB → `E_REMOTE_FILE_OVERSIZE { path, size, budget }`.
- `listRemoteTree`: a missing `dir` is `[]`; submodules are omitted; entries beyond `depth` are dropped
  before names are checked.
- `fetchRemoteTree`: `destDir` must not exist; a missing `dir` is `E_REMOTE_PATH_MISSING`. Every entry is checked before anything is written, then
  the copy is staged and renamed in. `E_REMOTE_TREE_UNSAFE { why }`: `path` (a name component empty,
  `.`, `..`, `.git` or containing `\` or NUL), `collision` (equal under NFC and case folding), `symlink`
  (unless `allowSymlinks` admits it and it stays inside the tree), `device`, `oversize` (over 64 MiB),
  `exists`. The kernel admits one symlink (`OATS_ALIAS_SYMLINK`): `CLAUDE.md` → `AGENTS.md`.

**Content digest.** SHA-256 over `"F" NUL relpath NUL mode NUL size NUL bytes NUL` per file in byte-wise
path order, `mode` normalized to `755` or `644` (a checkout digests like the fetched tree). An admitted
symlink enters as `symlink:<target>`; empty directories and a top-level `.git/` do not count.

### 1.3 Access, cache, failures

- Git uses the operator's own configuration and credentials; `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=/usr/bin/false` and ssh `-o BatchMode=yes` mean nothing prompts. 30 s per git call; 10 minutes for the fetch of a commit.
- A commit is fetched depth 1 with its trees and its blobs up to 64 KiB (larger blobs on demand, when a read
  needs them; whole trees from a server without partial fetches; awebai/oats#384) into a bare cache `<cacheDir>/<sha256(key)>/` (default
  `~/.cache/oats/remotes`; the CLI honours `OATS_REMOTE_CACHE`) and pinned as `refs/oats/commits/<oid>`.
  The cache may be wiped at any time. Operations on one cache repo are serialized.
- Only a successfully parsed Git version below 2.45 authorizes a version-driven
  rebuild of a partial cache into full mode. A failed or unparseable version
  probe refuses the read as `E_REMOTE_UNREADABLE` under the existing failure
  classification, preserving the cache, fetch mode and all commit pins. A
  probe timeout stays `timeout` even before a session's deadline; unparseable
  output is `unknown`. This holds with or without a session. Failures are not
  memoized: a later call can probe again. Full caches remain full after a
  successful modern-version probe. The private strict probe and the
  version-or-`null` compatibility helper share one memo per executor. Each
  waiter can leave on its own timeout/cancellation, evicting only the memo
  entry it waited on. The launching caller's timeout and signal bound the
  shared Git process; its rejection reaches all remaining waiters, including
  those whose own deadlines have not expired. A later call can retry.
- Failures: `E_REMOTE_UNREADABLE { url, key, reason }`, `reason` ∈ `auth`, `not-found`, `network`,
  `timeout`, `unknown`. Nothing half-succeeds.
- Reference-bearing diagnostics choose an explicit entry point:
  `displayRepoRef(value, { pinned = false, rejectedValue = false } = {})` for
  selected reference values, `displayDiagnosticText(value, source = null,
  { fragment = false, refusal = false, substitute = true, rejectedValue = false } = {})`
  for kernel-authored prose, and `scrubGitLine(line, url = null)` for Git's
  lines. One private renderer owns the [display rule](../workspaces.md#repository-references-in-diagnostics).
  The entries extract only their named options and fix their own contexts;
  reference or kernel-prose options cannot select Git-line handling.
  `displayRepoRef` accepts `pinned: true` for a whole `<ref>@<commit>` source
  or `pinned: { ref, commit }` for its original components; both strictly
  validate reference and commit without a plain-value fallback. Display
  changes no admission, transport, operational value or error shape. These
  are internal/direct-module entry points, not package export-map entries;
  there is no implicit `redactUrl` export or shim.

---

## 2. `lib/workspace.mjs` — declarations, membership, discovery

### 2.1 Declaration files

Schemas are in `docs/*.schema.json`; the `validate*` functions add the domain rules and are the
authority. Only `schemaVersion: 2` is read.

```yaml
# oats-workspace.yaml (committed in the host)
schemaVersion: 2
name: <slug>
members: [<repo ref>]                       # no @revision
packages: { <id>: v2.1.3 | git:<repo>@<ref> }
teams: { <label>: { team?: <provider team id>, description? } }   # shared teams
defaults:
  capabilities: { <cap>: { from: <repo key> | package } | off }
  knowledge | messaging | tasks: { <cap>: { from } } | none        # at most one entry
stores: { <name>: <repo ref> }
messaging: <opaque provider payload>
external: [{ source: <repo ref>@<full OID>, soul: <repo-relative dir> }]
```

- `oats-membership.yaml` (in each member): `{ schemaVersion: 2, workspace: <repo ref> }`, the backlink.
- `souls/<name>/soul.yaml`: `name` (equal to the directory), `description`, `work`
  (`worktree | checkout | directory | workspace`), `capabilities` (`{ from: here | package | <repo key> }`
  or `off`), slot payloads (`knowledge | messaging | tasks`: opaque or `none`), `compatibility`.
  `private:` is ignored with the warning `soul-private-ignored`.
- `oats-local.yaml` (per machine): `workspace` (required), `standalone`, `clones`, `settings`,
  `souls.disabled`, local team keys, host keys ([configuration](../configuration.md)). `loadLocal(dir)`
  walks up to it: none is `E_LOCAL_MISSING`; an `oats-config.yaml` on the way is `E_CONFIG_BROKEN`.

**Teams.** Shared teams and their provider ids are in `oats-workspace.yaml` `teams:`. Local teams,
`defaultTeam`, `souls.teams` and `souls.default` are in `oats-local.yaml`. There is no `team:` in soul,
membership or `external[]` entries, no `byTeam`, and no kernel-defined team. See
[Team model v2](2026-09-27-team-model-v2.md).

### 2.2 Validation rules

- **Absolute paths** are refused in ref and path fields only (`members`, `packages`, `stores`,
  `external[].source` and `.soul`, `defaults.*.from`), never in descriptions or `messaging`.
  `file:///…` and `git:/abs/bare.git@<ref>` are repo refs, not paths.
- **`from:`** is `package`, `here` (souls only) or a key spelled exactly as `parseRepoRef(ref).key`.
- Members must parse and not repeat. `packages:` values have exactly two forms (§2.6).
- **Removed keys** (`defaults.byTeam`, `messaging.byTeam`, `external[].team`, `team` in membership and
  soul files, top-level `byTeam` in a soul slot payload or `settings.<cap>`) are problems with
  `reason: "removed-key"`.
- Invalid files raise `E_WORKSPACE_SCHEMA { path, repoKey, commit, problems[] }`.

### 2.3 Membership

`confirmMembership(workspaceObs, memberRef)` reads the member's `oats-membership.yaml` at its default
branch, in the same access context → `{ key, commit, confirmed: true }` or `{ key, confirmed: false,
reason, detail }`, `reason` ∈ `not-listed`, `cannot-read`, `no-backlink` (missing, invalid or unusable
file) and `backlink-elsewhere` (`caseOnly: true` when only letter case differs). It throws only for an
invalid workspace file.

### 2.4 Discovery

```js
discoverWorkspace(ref, { at, local, lock })
// → { workspace, key, url, commit, observedAt, members, external, packageSouls, problems, warnings }
// member row: { key, ref, commit, confirmed, reason?, detail?, souls, capabilities, publishes }
// SoulEntry:  { name, path, repoKey, commit, private: false, definition }
// CapEntry:   { name, path, repoKey, commit, private, manifest }
```

- A repo without `oats-workspace.yaml` is `E_WORKSPACE_SCHEMA { notAHost: true }`.
- An unconfirmed member contributes only its row. A failure or invalid item in one member is a problem,
  never an abort; of two same-named items in one repo, the second is a problem.
- Members are read at their latest commit. A capability manifest needs `capability`
  (`^[a-z0-9][a-z0-9._-]*$`) and `version` and must pass the kernel manifest contract, or it is not listed.
- `publishes: { package, version } | null` reports a member's `oats-package/` (§2.6).
- Package souls come from the lock, at the locked commit, for still-declared packages: `package`,
  `version`, `qualifiedName` (`<package>/<soul>`), `agentName` (`<package>--<soul>`), `digest`.
- `external[]` souls are read at the pinned OID.

### 2.5 Standalone view

A standalone view is a member whose workspace cannot be read. `discoverOrStandalone(local)` builds it
when `oats-local.yaml` says `standalone:` (`standaloneReason: "explicit"`), or when `workspace:` names a
member whose host fails with `auth` or `not-found` (`"unreadable-host"`, with `hostFailure { code,
reason, url }`); `network` and `timeout` propagate. The repo must carry `oats-membership.yaml`. The view
has `standalone: true`, `workspace: null` and one unconfirmed row (`cannot-read`); souls keep only
`from: here` capabilities, plus `oats.core: { from: package }` unless the soul mentions `oats.core`.

### 2.6 Member vs package tier — the non-collapse rule

A repository may be a member (its `souls/*` and `capabilities/*`, latest commit) and publish a package
(its `oats-package/`, consumed only through `packages:`, versioned and locked). They never collapse:

- `from: <repo key>` looks only at `capabilities/<name>/oats.json`. A name found only in the repo's
  package is `E_CAPABILITY_MISSING` with `details.hint: "provided by package <id>; use from: package"`.
- `from: package` looks only in the lock, even when the package's repo is a member.
- A `packages:` value is a **bare version** (`v2.1.3`, through the official catalog) or
  **`git:<repo>@<ref>`** (`<repo>` any §1 form, `<ref>` a tag or full OID). There is no third form;
  `classifyPackageValue` is the one grammar. A branch is refused (§4.3).

---

## 3. `lib/resolve.mjs` — from a soul to an immutable resolution

`resolveSoul(discovery, soulEntry, { local, lock, spawn: { providers }, catalog })` → Resolution.

### 3.1 Membership gate

The soul must be one the discovery lists: a confirmed member's (same `repoKey`, `name`, `commit`; or the
repo's own, standalone), an `external[]` soul, or a listed package soul. Otherwise `E_NOT_A_MEMBER`,
`E_MEMBERSHIP_UNCONFIRMED { reason }` (`reason: "stale"` for an entry the row lacks), or
`E_PACKAGE_MISSING { reason: "stale" }`. An in-memory lock is validated (`E_LOCK_SCHEMA`).

### 3.2 Composition and lookups

Order, soul wins, `off` removes: `defaults.<slot>` ⊕ `defaults.capabilities` ⊕ `soul.capabilities`.
Teams compose nothing: composition is the same for every person and machine.

- `from: here`: the soul's repo; in a package soul, its own locked package.
- `from: <repo key>`: a confirmed member (`E_NOT_A_MEMBER`) listing it (`E_CAPABILITY_MISSING`). A
  `private` capability serves only its own repo's souls (`E_CAPABILITY_PRIVATE`).
- `from: package`: a lock (`E_PACKAGE_MISSING { reason: "no-lock" }`), one locked provider
  (`E_PACKAGE_MISSING`, `{ ambiguous }` for two), still declared (`reason: "undeclared"`). The package
  must list exactly the lock's capabilities (`E_PACKAGE_INTEGRITY { why: "capabilities" }`).

Declaring a package is the trust decision; there is no approval gate. Member capabilities are trusted by
membership and their hooks run on every operator's machine, so a mixed public/private organisation keeps
executable capabilities in packages or private members.

### 3.3 Slots

- A module with `layer: <slot>` fills that slot; two are `E_SLOT_CONFLICT`.
- A slot default must be of that layer (`E_SLOT_CONFLICT { reason: "layer-mismatch" }`).
- A soul's `<slot>: none` drops `defaults.<slot>` and every capability of that layer the workspace
  defaults contributed. One the soul itself declares beside `none` is `E_SLOT_CONFLICT { reason: "none" }`.

### 3.4 Payloads

Merged per module, later wins (objects deep-merge): manifest `settings.<key>.default` ⊕
`workspace.messaging` (messaging layer) ⊕ soul slot payload ⊕ `oats-local.yaml settings.<cap>` ⊕
`--provider <cap> k=v`. All refusals are `E_WORKSPACE_SCHEMA` with a `reason`:

- `poison-key`: `__proto__`, `constructor` or `prototype` at any depth;
- `removed-key`: top-level `byTeam` (any segment of a `--provider` key);
- `host-only-key`: a manifest `hostOnly` key outside `oats-local.yaml`, so host paths stay out of
  committed files;
- `setting-value`: a value outside `settings.<key>.values`.

`--provider` for a capability the soul does not resolve is `E_CAPABILITY_MISSING`. The kernel merges and
delivers; what a provider consumes is its own contract. Teams reach providers as `OATS_DEFAULT_TEAM*` and
`OATS_TEAMS`, not in settings.

### 3.5 Checks

- `skills[]` entries must hold `SKILL.md` or `<skill>/SKILL.md` (`E_CAPABILITY_MISSING` or
  `E_PACKAGE_MANIFEST`); a skill name twice is `E_SKILL_DUPLICATE`.
- `compatibility.oats` must admit the kernel (`E_CAPABILITY_INCOMPATIBLE`); `agents:` in a manifest is
  `E_CAPABILITY_AGENTS_REMOVED`.
- `soul.compatibility` floors apply to package versions; an OID or non-version pin is
  `E_COMPATIBILITY { why: "unversioned" }`.

### 3.6 The Resolution

```js
{ resolutionApi: 1, soul: { name, repoKey, commit, path },
  modules: [{ name, layer, private, dir, manifest,
              from: { kind: "member", repoKey, commit }
                  | { kind: "package", package, version, commit, integrity, repoKey } }],
  slots, skills, injects, payloads, payloadOrigins,
  teams, defaultTeam, slotsFrom, capabilitiesFrom, instructionOrder, turnedOff, declRevision, payloadRevision, revision }
```

`module.dir` is the listed capability directory (for a package, the `oats-package.json#capabilities[]`
entry). `declRevision` covers `{ resolutionApi, soul, modules, slots, skills, injects }`,
`payloadRevision` the payloads, `revision` both (24 hex of SHA-256 over canonical JSON). A spawn decision
binds `revision`. Provenance fields enter neither revision. `instructionOrder` is one: the module names
in the order their injects take in the composed `AGENTS.md` (the soul's `capabilities:` order, then the
workspace defaults it does not list, in `defaults:` file order).

---

## 4. `lib/packages.mjs` — packages and lock v3

Nothing is installed; `oats-lock.json` and `oats-local.yaml` are the only persisted deployment state.

### 4.1 Lock v3

```js
{ lockfileVersion: 3, packages: { <id>: {
    source: "catalog:<id>" | "git:<key>@<ref>", url, path, version, commit, integrity,
    capabilities: [<cap>], souls?: [{ name, path, digest }] } } }
```

`readLock` (missing file: empty lock) and `writeLock` (atomic, canonical). `url` lets spawn work without
a catalog; `integrity` is the content digest of the tree at `path`. Any other `lockfileVersion` is
`E_LOCK_SCHEMA`. A legacy `approved` field is ignored and dropped on write.

### 4.2 `resolvePackages(workspace, { catalog, lock })`

A catalog version resolves through `package-catalog.json` shipped with the kernel
(`OATS_PACKAGE_CATALOG` overrides; unknown id: `E_PACKAGE_MISSING`); a git value reads `oats-package/`.
Each entry's manifests, souls and integrity are read at the observed commit →
`{ lock, changes: [{ id, from, to, commit }] }` (`to: null`: no longer declared).

- A branch is `E_PACKAGE_INTEGRITY { why: "branch" }`.
- A manifest whose `package` is not the entry's key is `E_PACKAGE_INTEGRITY { why: "package-id" }`,
  fresh or already locked.
- An unchanged version, source and path is re-verified: a moved commit or different integrity,
  capabilities or souls is `E_PACKAGE_INTEGRITY`.
- A malformed package is `E_PACKAGE_MANIFEST`.

`packageProviding(lock, cap)` → `{ id, entry }`, `null` or `E_PACKAGE_MISSING { ambiguous }`.

### 4.3 Trust and removed APIs

There is no approval step or record: declaring a package in `packages:` is the trust decision, and the
lock pins commit and integrity. `oats sync --approve` is `E_BAD_ARGS`. Pre-workspace exports remain as
shims that throw `E_REMOVED { name, contract }`, pointing at this record.

---

## 5. `lib/materialize.mjs` — copy whole, compose, record

### 5.1 `materialize(resolution, home, options)`

1. Fetch each module at `from.commit` from `module.dir` into `<home>/.oats/modules/<name>/`. A package
   must match the lock's commit (`E_MATERIALIZE_INTEGRITY { why: "lock" }`); an unknown repo is
   `E_MATERIALIZE_SOURCE`.
2. The copy's digest must equal the fetch's and any `module.digest` (`E_MATERIALIZE_INTEGRITY`).
3. Copy skills whole to `<home>/.agents/skills/<skill>/`, flat (0.30.2; the grouped
   `<name>/<skill>/` layout this section first specified hid every skill from the harnesses).
4. Compose `<home>/AGENTS.md` = soul body (`options.soulAgentsMd` or `soulDir`) + module injects in
   `instructionOrder` + kernel blocks (`options.blocks`); operating guidance comes from a module such as `oats.core`. Keep `CLAUDE.md → AGENTS.md`
   and `.claude/skills → ../.agents/skills`.
5. Record `modules: { <name>: { from, commit, digest, materializedAt } }`, `providers` (the payloads) and
   `resolutionRevision` in `instance.json`.

Everything is staged, then renamed in with a rollback journal: any failure restores the previous files
(`E_MATERIALIZE_HOME { why }`; a concurrent run is `why: "busy"`).

### 5.2 Soul source and instance record

- A workspace soul's source goes to `agents/<agent>/souls/<commit12>/`, immutable and never removed;
  `agents/<agent>/soul` is an atomically swapped symlink to the current one. A package soul must match
  its locked digest (`why: "soul-digest"`); a source without `soul.yaml` or `AGENTS.md` is
  `E_SOUL_INCOMPLETE`. A preview writes nothing.
- Homes carry no soul link. `instance.json` records `soulDir` (the instance's own commit directory),
  `workspace: { key, name, deployment, commit, resolution, standalone, soul: { id, repoKey, commit },
  layers }`, `teams`, `defaultTeam` and `capabilityMeta` (hook `meta`, merged at spawn and every launch;
  retire reads it as `OATS_META`).
- Hooks get `OATS_SOUL` (`soulDir`) and `OATS_SOUL_ID`, a stable key for provider state:
  `<repo key>#<soul>`, or `package:<id>#<soul>` for a package soul.

### 5.3 Drift

`driftOf(instanceJson, discovery, { lock })` → `[{ module, from, recorded, current, status, reason? }]`,
`status` ∈ `current | moved | missing`, against the member's commit or the lock. `soulDriftOf` does the
same for the recorded soul. Drift is shown, never prevented.

---

## 6. CLI verbs and DTOs (`bin/oats.mjs`)

Verbs take `--dir` (walks up to `oats-local.yaml`) and `--json` (one envelope).

### 6.1 `oats onboard [<dir>] --workspace <repo ref>`

Writes `oats-local.yaml` and `agents/`, then runs the `sync` body. An existing `oats-local.yaml` there is
`E_ALREADY_ONBOARDED`; a failure before the workspace is read rolls back (`details.rolledBack: true`).
→ `{ onboardApi: 2, standalone?, local, dir, agents, lock, sync, hosting: { host, hostIsMember, rule },
next: { clone: [{ key, name, url, dir, present, host }], spawn, souls } }`.

### 6.2 `oats sync`

Discovers, resolves `packages:`, writes the lock, creates `agents/`, refreshes the automations
snapshot (standalone: only the catalog package providing `oats.core`). → `{ syncApi: 1, standalone?,
workspace: { name, key, url, commit, observedAt, local, lock }, members: [{ key, name, commit,
confirmed, status, detail, souls, capabilities, publishes }], packages: [{ id, version, source, commit,
integrity, capabilities, souls }], changes, problems, warnings, automations }`. Text: §8.

### 6.3 `oats package add <id> <value> | remove <id>`

Edits `packages:` only when `oats-workspace.yaml` is tracked by its checkout; otherwise prints the change
to make. Invalid value: `E_WORKSPACE_SCHEMA`; removing an undeclared id: `E_PACKAGE_MISSING`. Receipts:
`{ action, id, value, previous, edited: true, file }` or `{ action, id, value, edited: false, file: null,
line, hint }` (`line: null` for `remove`).

### 6.4 `oats workspace status`, `oats capabilities`, `oats souls`

- `workspace status` → `{ workspaceStatusApi: 1, standalone?, workspace: { name, key, url, commit,
  observedAt, local, teams, file }, members, packages, declaredPackages, unsynced, stale, external,
  automations, defaults, clones, disabledSouls, lock }`.
- `capabilities` / `souls` → `{ capabilitiesApi | soulsApi: 1, standalone?, workspace, capabilities |
  souls, problems }`: every item of confirmed members, external and package souls, and locked package
  capabilities, with `origin` and `kind`. Private capabilities carry `private: true`; soul rows carry
  `teams` and `defaultTeam`.

### 6.5 `oats spawn <soul>`

- A bare name must be unique (`E_SOUL_UNKNOWN`, `E_SOUL_AMBIGUOUS`); `<member>/<soul>` or
  `<package>/<soul>` qualifies it. A disabled soul is `E_SOUL_DISABLED`.
- Discover → resolve → materialize; `--provider <cap> <key>=<value>` is the spawn payload layer.
- `--preview` adds `modules` (`{ name, from, layer, private, declares, changedSince }`), `teams`,
  `defaultTeam`, `resolution`, `declRevision`, `payloadRevision`, `providers` (as typed), `settings` and
  `settingsOrigins`. The decision binds `revision` and `effective.providers` (`E_DECISION_STALE`).
- Member clone for `worktree | checkout`, first hit wins: `--repo`; `clones:`; `<deployment>/<member>`
  (`agents` → `agents-repo`). None is `E_CLONE_MISSING`; a clone of another repo `E_CLONE_MISMATCH`.
- `work: workspace`: `./work` is the deployment directory; no branch is recorded.

### 6.6 `oats status`

`--json` adds, per `agents[].instances[]`, `modules` and `soul` drift rows (§5.3) and `identity` from the
messaging capability's meta. An unreachable workspace gives `workspace: { reachable: false }`. Outside a
deployment: `E_NO_DEPLOYMENT`.

### 6.7 Capability commands from a deployment

Inside a home, `oats <ns> <cmd>` uses the home's modules. From a deployment, `lib/operator-dispatch.mjs`
resolves as a spawn of `--soul <name>` would (missing `--soul`: `E_BAD_ARGS`). The module whose
`manifest.command` is `<ns>` is fetched into `<deployment>/.oats/modules/<cap>@<commit12>/`, digest-verified
(`E_PACKAGE_INTEGRITY { why: "module-store" }`), and run with `OATS_SETTINGS` (its merged payload) and
`OATS_CLI_BIN`. Two claimants: `E_DUPLICATE_NAMESPACE`; none: `E_UNKNOWN_COMMAND`.

### 6.8 `oats version --json` and removed verbs

`workspaceApi: 2`; features are listed only once implemented (`workspace-v2`, `instance-modules`,
`spawn-provider-payload`, `packages-no-approval`, `package-souls`, `team-model-2`, among others). Removed
verbs (`prepare`, `create`, `type`, `install`, `restore`, `init`, `use`, `trust`, `list`, `catalog`,
`remove`, `migrate`, `config`, `inject`) answer `E_UNKNOWN_COMMAND` with `details.removed` and
`details.replacement`; `session recompose` is also `E_UNKNOWN_COMMAND` (re-spawn instead).

---

## 7. Test fixture — `test/fixtures/northwind/build.mjs`

`buildNorthwind(baseDir)` builds bare Git repos under `<baseDir>/remotes/`:

| Repo | Role |
|---|---|
| `agents` | host and member (`release-manager`, `support-triager`; `nw-release-tooling`, `nw-house-style`) |
| `platform`, `data`, `marketing` | members with souls and capabilities, some executable |
| `nw-tools` | member that also publishes package `nw.tools` v0.4.0 (`nw-lint`, `nw-deploy`) |
| `knowledge` | a store, not a member |
| `experts` | external soul `security-reviewer`, pinned by OID |
| `pkg-okf`, `pkg-framework` | catalog packages `oats.okf` v2.1.3 (knowledge layer, hooks, a `hostOnly` setting) and `oats.framework` v1.1.3 (`oats.core`) |

There are exactly two catalog package repos; `nw.tools` is pinned `git:<nw-tools ref>@v0.4.0`, which
exercises the non-collapse rule. The workspace declares three shared team labels without ids,
`defaults.messaging` and `defaults.tasks` as `none`, and `from:` values as `local/<abs-path>` keys.

It returns `{ baseDir, remotesDir, refs, urls, keys, commits, tags, catalog, moves }`, is deterministic
(fixed identity and dates, hermetic git config), and refuses a `baseDir` with whitespace or `@`
(`E_FIXTURE_BASEDIR`) or an existing `remotes/` (`E_FIXTURE_EXISTS`). Helpers: `moveMember`,
`dropBacklink` (→ `no-backlink`), `makeUnreadable` (→ `cannot-read`, returns `restore`).

---

## 8. The human sync report

`oats sync` and `oats onboard` without `--json` print:

```text
workspace  <name>  (<key> @ <commit8>)
members    <name> ✓↔ (@ <commit8>)   <name> ✗ (<status>)
packages   <id> <version> ✓ (@ <commit8>)
changed    <id>  <from|—> → <to> (@ <commit8>)   <id>  <from> → removed
souls      N discovered (M members, E external, P package, D disabled here) · K private capabilities
teams      <label>, … (shared) · this deployment's: oats teams
automations T triggers, S schedules in the members (oats trigger list · oats schedule list)
problem    <code>  <member>:<path>  <message>
warning    <code>  <message>

lock       <path to oats-lock.json>
```

`changed` reads `(nothing — the lock already described this workspace)` when empty. A standalone view
prints its note in place of the name. `automations` appears only when there are some; `problem` and
`warning` repeat per item.

---

## Post-0.25.0 clarifications

Folded into the sections above: operator-level capability commands (§6.7); `work: workspace` (§6.5);
host paths and `hostOnly` keys (§3.4); member capabilities as a code-execution boundary (§3.2, §4.3);
slot `none` (§3.3); the two revisions (§3.6); peeled commits and transport (§1); the per-commit soul
cache, `OATS_SOUL_ID` and persisted launch `meta` (§5.2); clone lookup and preview payloads (§6.5);
soul drift (§5.3).
