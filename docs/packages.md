# Packages: the versioned tier

A **package** is a place to fetch capabilities from *with a version attached*.
It is one of the two kinds of capability source in the
[workspace model](workspaces.md); the other — a member repo — is never
versioned. Nothing is installed: a package is resolved to an exact commit by
`oats sync`, recorded in `oats-lock.json`, and **copied whole into each
instance at spawn** (`<home>/.oats/modules/<cap>/`).

Ground truth: [`oats-package.schema.json`](oats-package.schema.json) (the
package manifest), the [lock v3 format](#lock-v3) below (`validateLock` in
`lib/packages.mjs` is its authority; it has no JSON schema), and the module contract
[design/2026-09-23-workspace-module-contracts.md §4](design/2026-09-23-workspace-module-contracts.md).

## What a package is

A Git repository **contains** a package at `oats-package/`:

```
<repo>/
└── oats-package/
    ├── oats-package.json                # { "package": "acme.tools", "version": "0.4.0", "capabilities": ["capabilities/acme-lint", "capabilities/acme-deploy"] }
    └── capabilities/
        ├── acme-lint/oats.json          # ordinary capability manifests (docs/capabilities.md)
        └── acme-deploy/
            ├── oats.json
            └── bin/acme-deploy.mjs      # an executable — trusted by declaring the package
```

`oats-package.json` must declare `package` and `capabilities` (a list of
directories relative to the package root, each holding an `oats.json`). It may
also declare `souls`: soul directories the package ships, see
[Package souls](#package-souls). A
directory entry need not equal the capability's name
(`capabilities/oats-okf` → capability `oats.okf`). A package declaring one
capability name twice, a listed directory without a manifest, or a manifest
without `capability` is `E_PACKAGE_MANIFEST`. Catalog entries may name another
`path` than `oats-package`; a `git:` ref always reads `oats-package/`.

## Declaring packages

The workspace file's `packages:` map is the **only** list of versions in the
whole organisation:

```yaml
packages:
  oats.okf: v5.8.0                                    # bare version → the official catalog
  acme.tools: git:github.com/acme/tools@v0.4.0        # direct ref: git:<repo>@<tag or full OID>
```

- **Bare version** (`v5.8.0`, `5.8.0`, `1.0.0-rc.1`): the id is looked up in
  the official catalog — `package-catalog.json` in the `oats` repo, or the file
  named by `OATS_PACKAGE_CATALOG` — which supplies the repo url, the tag
  convention (`v5.8.0` or `oats-framework/v1.22.1`) and the payload path. An id
  the catalog does not know is `E_PACKAGE_MISSING` ("use `git:<repo>@<ref>` for
  a package outside the catalog"). The catalog is the reviewed official list
  ([official-catalog.md](official-catalog.md)) and the only way a
  package becomes pinnable *by id*.
- **`git:<repo>@<ref>`**: `<repo>` is any repo ref the kernel understands
  (`github.com/org/repo`, `https://…`, `git@host:…`, `/abs/bare.git`,
  `file:///…`); `<ref>` is a tag name or a full 40-hex commit. The package is
  read at `oats-package/`.

A whole workspace file pinning the current official packages — its bare
versions are kept equal to `package-catalog.json` by
`test/docs-catalog-pins.test.mjs`, so a catalog pin round updates this example
in the same change:

<!-- catalog-pins -->
```yaml
schemaVersion: 2
name: acme
members:
  - git:github.com/acme/agents
  - git:github.com/acme/platform
packages:
  oats.framework: v1.22.1
  oats.okf: v5.8.0
  oats.aweb: v1.37.0
teams:
  platform: { team: "platform:acme.aweb.ai", description: Platform engineering }
defaults:
  capabilities: { oats.core: { from: package } }
  knowledge: { oats.okf: { from: package } }
  messaging: { oats.aweb: { from: package } }
  tasks: none
stores:
  org: git:github.com/acme/knowledge
messaging:
  private: per-human
```

There is no third form; `lib/packages.mjs#classifyPackageValue` is the one
grammar, used by workspace validation and by `sync`. A `<ref>` (or catalog ref)
that resolves to a **branch** is refused: `E_PACKAGE_INTEGRITY { why: "branch" }`
— versions are immutable.

Souls never name versions. A soul says `acme-deploy: { from: package }`; which
package provides `acme-deploy`, and at which version, is the workspace's
decision recorded in the lock.

## `oats sync` — the one command for the common path

```
$ oats sync
workspace  acme  (github.com/acme/agents @ 3f2a9c1e)
members    agents ✓↔ (@ 3f2a9c1e)   platform ✓↔ (@ 77c0a1b2)   billing ✗ (no-backlink)
packages   acme.tools 0.4.0 ✓ (@ 47f4b816)   oats.okf 5.8.0 ✓ (@ cfc595a9)
changed    acme.tools  — → 0.4.0 (@ 47f4b816)
souls      9 discovered (6 members, 1 external, 2 package, 0 disabled here) · 0 private capabilities
teams      platform (shared) · this deployment's: oats teams

lock       oats-lock.json
```

`sync` (run from the deployment — where `oats-local.yaml` is, or `--dir`):

1. discovers the workspace over the remotes and confirms every member;
2. resolves each `packages:` entry to a commit (`observeRemote`), reads its
   manifests, computes the **integrity** (content digest of the package tree)
   and records `url`, `path`, `version`, `commit`, `integrity`, `capabilities`;
3. for an entry already locked at the same version/source/path: the commit must
   be unchanged (else `E_PACKAGE_INTEGRITY` — "the tag moved; a version string
   must change when its content does") and the integrity must match
   (`E_PACKAGE_INTEGRITY`);
4. writes `oats-lock.json` and reports the diff. Entries dropped from
   `packages:` are dropped from the lock.

Declaring a package in the workspace's `packages:` is the trust decision
([Trust](#trust)): `sync` asks nothing and exits `0` on success. `--json` emits the
`syncApi: 1` envelope documented in
[desktop-cli-api.md](desktop-cli-api.md#workspace-model-workspaceapi-2).

## `oats package add | remove`

```bash
oats package add oats.aweb v1.37.0                         # a catalog version
oats package add acme.tools git:github.com/acme/tools@v0.4.0
oats package remove acme.tools
```

Both edit `packages:` in `oats-workspace.yaml` **when the file is tracked by
the Git checkout the command runs in** (the workspace host repo); the edit is
validated against the full workspace schema before it is written, and the
receipt tells you to commit and `oats sync`. Anywhere else (a deployment folder,
a member clone) the command prints the line to add (`--json`: `edited: false`,
`line`) because the workspace file is shared through Git, not through this
machine. Nothing network-bound happens in `package add`; `sync` resolves.

## Lock v3

`oats-lock.json` lives beside `oats-local.yaml`. Two operators who synced the
same workspace commit hold identical locks.

```json
{
  "lockfileVersion": 3,
  "packages": {
    "oats.okf": {
      "source": "catalog:oats.okf",
      "url": "https://github.com/awebai/oats-okf.git",
      "path": "oats-package",
      "version": "5.8.0",
      "commit": "56dbc167394bbc13cc900bd8af0c64b74fecae54",
      "integrity": "sha256-…",
      "capabilities": ["oats.okf", "oats.okf-harvest", "oats.okf-maintenance"]
    },
    "acme.tools": {
      "source": "git:github.com/acme/tools@v0.4.0",
      "url": "https://github.com/acme/tools.git",
      "path": "oats-package",
      "version": "0.4.0",
      "commit": "47f4b81660e4cc9701d373088de52462762585a3",
      "integrity": "sha256-4cd126a7…",
      "capabilities": ["acme-deploy", "acme-lint"],
      "souls": [{ "name": "release-reviewer", "path": "souls/release-reviewer", "digest": "sha256-9a0f…" }]
    }
  }
}
```

| field | meaning |
|---|---|
| `source` | `catalog:<id>` or `git:<repo key>@<ref>`: how the workspace asked for it |
| `url` | the repo url the package was read from; travels in the lock so spawn needs no catalog |
| `path` | the package root inside the repo |
| `version` | the version string without a leading `v` (a `git:…@<OID>` pin records the OID) |
| `commit` | full 40-hex OID the version resolved to |
| `integrity` | `sha256-<hex>` content digest of the package tree at `path` |
| `capabilities` | the capability names the package provides (sorted): what `from: package` looks up |
| `souls` | the package souls, sorted by name: `name`, `path` (inside the package) and `digest` (`sha256-<hex>` of the soul directory); absent when the package ships none |

A capability provided by **two** locked packages is ambiguous and fails
closed (`E_PACKAGE_MISSING { ambiguous: [ids] }`): keep one of them in
`packages:`. A lock that is not v3, or cannot be read, is `E_LOCK_SCHEMA`; it
is never repaired automatically: delete it and `oats sync`. Agents never
hand-edit the lock.

## Trust

Member capabilities are trusted by membership; **a package is trusted by its
declaration in the workspace's `packages:`**. People declare a package only
when they trust it, so there is no second, per-version approval step. The lock is reproducibility, not approval: it pins
the exact commit and the content integrity, a moved tag or drifted content is
`E_PACKAGE_INTEGRITY`, and at spawn the lock's capability list must match what
the package declares at the locked commit (`E_PACKAGE_INTEGRITY { why:
"capabilities" }`).

## Materialization from a package

At spawn a `from: package` module is fetched at the lock's commit from the
lock's `url`, at the manifest-listed directory (`oats-package.json#capabilities[]`
entry), into `<home>/.oats/modules/<cap>/`; the copy's digest is verified
against what the fetch reported; skills are copied to
`<home>/.agents/skills/<skill>/` (flat). `instance.json.modules.<cap>.from` is
`{ kind: "package", package, version, commit, integrity, repoKey }`. Bumping
`packages:` and syncing affects **only new spawns**; `oats status` shows a
running instance's package module as `moved` once the lock points elsewhere.

## Package souls

A package may ship **souls** as well as capabilities. One pin in
`packages:` then versions both: nothing drifts, unlike an `external:` soul's
commit pin.

```
oats-package/
├── oats-package.json      # { …, "capabilities": ["capabilities/acme-review"], "souls": ["souls/release-reviewer"] }
├── capabilities/acme-review/oats.json
└── souls/release-reviewer/
    ├── soul.yaml          # an ordinary soul: name = the directory's name
    ├── AGENTS.md
    └── skills/…
```

- **Locked.** `oats sync` records each soul's `name`, `path` and `digest` in
  the lock entry. A soul without `soul.yaml` or `AGENTS.md`, or whose
  directory is not a soul name, is `E_PACKAGE_MANIFEST`. On a later sync at
  the same version the souls must still match (`E_PACKAGE_INTEGRITY { why:
  "souls" }`).
- **Listed.** `oats souls` lists a package soul with `kind: "package"`,
  `package`, `version`, `qualifiedName` and `origin: "package <id>
  v<version>"`; `oats sync` / `oats workspace status` list each package's
  `souls`. Only packages the workspace still declares are listed.
- **Named.** The qualified name is `<package>/<soul>` (`oats.okf/knowledge-maintainer`).
  A bare name works when it is unique across member, external and package
  souls; otherwise `E_SOUL_AMBIGUOUS` names each qualified form
  (`details.qualified`). A member soul's qualified form is `<member name>/<soul>`.
- **Resolved** like any soul: the workspace defaults apply, `off` and
  `<slot>: none` work, its teams are keyed `<package>/<soul>` (or `<package>/*`)
  in the workspace's `souls:` (unlisted, it joins its default only), and
  `from: here` means **this package** at the locked commit
  (a capability it does not provide is `E_CAPABILITY_MISSING`).
- **Spawned** at the locked commit: the soul is fetched into the per-commit
  soul cache and its digest must equal the lock's (`E_PACKAGE_INTEGRITY
  { why: "soul-digest" }`). A package soul homes in its own agent directory,
  `agents/<package>--<soul>/` (the package id with `.` as `-`:
  `agents/oats-okf--knowledge-maintainer/`), which is also its agent name
  (`OATS_AGENT`, the `oats status` row); its instances are named from it
  (`oats-okf-knowledge-maintainer-<purpose>`). That prefix counts toward the
  64-character instance-name limit, so a package soul's purposes are short:
  `oats-okf-knowledge-maintainer-` is 30 characters, which leaves 34 for the
  purpose (fewer when a `-2` suffix de-duplicates it). A longer one is
  `E_INSTANCE_NAME_INVALID { prefix, purpose, maxPurpose }`, naming the budget;
  a trigger's or schedule's purpose template obeys the same limit when it
  renders. A soul name never holds `--`,
  so a member soul of the same bare name keeps its own `agents/<soul>/`.
  Two packages whose ids sanitise alike (`a.b`, `a-b`) and that ship a
  same-named soul would share a directory: both are listed with an
  `E_SOUL_AMBIGUOUS` problem, and spawning either is `E_SOUL_AMBIGUOUS
  { agentDir, qualified }` — keep one of the packages.
  `instance.json.workspace.soul` records `name`, `qualifiedName`, `package:
  { id, version, commit, digest, path }` and the soul id `package:<id>#<soul>`;
  in `oats status` the soul is `moved` once the package pin moves.
- **Disabled** by `oats-local.yaml` `souls.disabled` by its qualified or bare
  name (`E_SOUL_DISABLED` at spawn). An entry is matched by name only, so an
  entry naming a soul that no longer exists fails open: after a pin's removal
  or rename, the soul it was meant to keep off spawns again under its new
  name. After removing or renaming a pin, or a soul it provided, run
  `oats doctor` and fix what it reports, and check `souls.disabled` by hand: an
  older kernel's doctor doesn't report such an entry.
- **Trusted** as the package's capabilities are: declaring the package is the
  trust decision.

## Trigger templates

A package may also ship **trigger templates**: `triggers: [{ id,
file }]` in `oats-package.json`, each file `{ parameters, definition }`.
`oats trigger add --from <package>:<id> --set <name>=<value>` instantiates one
at the locked commit; see [schedules.md#triggers](schedules.md#triggers).
A template's `definition` may carry `description`, the one-line summary its
triggers show (validated like any trigger's: one line of 1 to 200 characters
without control characters). `add --from` copies it and `--description=<text>`
overrides it; a workspace trigger made `from:` it shows its file header's
description, else the template's. A kernel before 0.43.0 refuses the key, so
a package whose template sets it needs `compatibility.oats: ">=0.43.0"`.

A template may name a capability's trigger source (feature
`trigger-sources`): its
`definition.on` is `{ source: "<capability>:<source>", params?, events,
poll? }`, and a parameter's `path` may point into `on.params` (for example
`on.params.prefix`). `add --from` checks what it means against the soul it
spawns, as for any capability-source trigger
([schedules.md](schedules.md#capability-sources)). A package does **not**
raise `compatibility.oats` for such a template: a template is read only by
`add --from`, so a kernel without feature `trigger-sources` refuses that one
`add --from` (`E_TRIGGER_INVALID` on `on.source`, or on `on.params` when the
template sets it), reports a workspace trigger made from it as a problem of
its snapshot, and uses the package's capabilities and souls as before. A
floor would refuse them all on every older host.

## Compatibility floors

A soul may state floors on package versions — constraints, not sources:

```yaml
compatibility:
  oats.okf: ">=4.0"
```

Checked at resolution against the locked version (`E_COMPATIBILITY`,
naming capability, package, version and range). A package pinned by OID has no
version to check (`why: "unversioned"`): pin a tagged version.

Separately, each capability's own `compatibility.oats` (its manifest's kernel
range) must admit the running kernel, for package and member capabilities
alike (`E_CAPABILITY_INCOMPATIBLE`); see [capabilities.md](capabilities.md).

## Publishing a package from a member repo

A repo can be a **member** of the workspace **and** publish a package; the two
roles never collapse (see [workspaces.md](workspaces.md#member-tier-vs-package-tier-the-non-collapse-rule)):

1. Put the package under `oats-package/` with its `oats-package.json` and
   capability directories. Everything under `capabilities/` at the repo root
   stays member-tier (latest state, for people working *on* the package —
   typically a `<name>-dev` capability); everything under `oats-package/` is
   package-tier.
2. Add a member soul that is the expert in the package (`souls/<name>-expert/`),
   ordinary and discoverable, the natural owner of the package's PRs. It eats
   its own published food: `acme-lint: { from: package }` at the pinned version,
   plus `acme-tools-dev: { from: here }`.
3. Tag a release (`v0.4.0`). Tags are immutable: a new content needs a new tag.
4. Consumers pin it: `oats package add acme.tools git:github.com/acme/tools@v0.4.0`
   → commit → `oats sync`. Discovery shows the member row with
   `publishes: { package: "acme.tools", version: "0.4.0" }`.
5. To become pinnable by id, open a PR adding the package to
   `package-catalog.json` in the `oats` repo ([official-catalog.md](official-catalog.md)).

A soul that names one of the package's capabilities with
`from: github.com/acme/tools` fails: `E_CAPABILITY_MISSING` with the hint
`provided by package acme.tools; use from: package`.

## Catalog shape

```json
{
  "policy": "docs/official-catalog.md",
  "packages": {
    "oats.okf":       { "url": "https://github.com/awebai/oats-okf.git", "ref": "v5.8.0", "path": "oats-package" },
    "oats.framework": { "url": "https://github.com/awebai/oats.git", "ref": "oats-framework/v1.22.1", "path": "oats-package" }
  }
}
```

`ref` carries the tag convention: a workspace's `oats.framework: v1.22.1`
resolves to tag `oats-framework/v1.22.1`. Resolving through the catalog never
advances a lock by itself: `oats sync` does, and says so.
