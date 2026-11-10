# The official OATS catalog

The official catalog is the reviewed [package-catalog.json](../package-catalog.json)
list in [awebai/oats](https://github.com/awebai/oats), not a separate registry
service. **A package listed there is official.** A name, logo, repository owner
or workspace membership alone does not make a package official.

## The packages

| package | release | capabilities | package souls |
|---|---|---|---|
| `oats.framework` | `oats-framework/v1.22.1` (this repository) | `oats.core`, `oats.setup`, `oats.onboarding`, `oats.support`, `oats.knowledge-theory` | `knowledge-theory-expert`, `oats-setup-expert` |
| `oats.okf` | `v5.8.0` | `oats.okf` (knowledge), `oats.okf-harvest`, `oats.okf-maintenance` | `knowledge-harvester`, `knowledge-maintainer` |
| `oats.aweb` | `v1.37.0` | `oats.aweb` (messaging), `oats.aweb-tasks` (tasks) | |
| `oats.engineering` | `v1.18.0` (frozen: see Coordination templates) | `oats.engineering-expert`, `oats.developer`, `oats.code-review`, `oats.maintainer` | `code-reviewer` |
| `oats.authoring` | `v1.0.3` | `oats.authoring` | |
| `oats.cloning` | `v1.1.0` | `oats.cloning` | `cloner` |
| `oats.jira` | `v1.0.1` | `oats.jira` (tasks) | |
| `oats.linear` | `v1.0.1` | `oats.linear` (tasks) | |
| `oats.apps` | `v1.0.0` | `oats.folio`, `oats.library` | |
| `oats.machine` | `v0.1.1` | `oats.machine-care` | `steward`, `technician` |

Each package lives in its own `awebai/oats-*` repository except
`oats.framework`, whose payload root is `oats-package/` here. A capability
written `{ from: package }` resolves through the workspace's lock, to the one
locked package whose capability list holds it: `oats.developer: { from: package }`
selects `oats.engineering` when that package is pinned and synced. Two locked
packages providing the same capability are refused with `E_PACKAGE_MISSING`,
which names both. The catalog's `capabilities` map records which official
package ships each capability (and a renamed capability's current name:
`oas.okf` is `oats.okf`); the kernel reads it only to pick a standalone
deployment's package (the one that ships `oats.core`). This catalog ships with
the CLI: an older installed CLI keeps its own copy, and a change here rewrites
no lock and adds nothing to an existing workspace.

## Coordination templates

OATS's coordination ships as templates, not packages: one for each way of
working, each in its own repository. An installed kernel's
copy of this catalog carries this section from the next kernel release; the
onboarding skills name the engineering template directly, so they work on an
older kernel too. A template is a
repository that a setup expert copies into a workspace's own capabilities and
adapts to the organisation by the repository's `ADAPTING.md`
(`/adapt-to-the-organisation`, in `oats.framework`); nobody pins it. Template
releases are tagged `template-v<version>`. Each copied capability records the
release it came from in its description, and the copy records it as a whole in
`capabilities/TEMPLATE-RELEASE`.

| Template | Latest release | Way of working |
| --- | --- | --- |
| `oats-project/oats-engineering-coordination` | `template-v2.1.0` | Work that lands as pull requests: a dispatcher, a lead for each effort, developers who own their pull requests, a fresh reviewer each round, and a maintainer where a lane needs one. |
| `oats-project/oats-research-coordination` | `template-v1.0.0` | Work that ends in a finding or a report: a dispatcher, a research lead for each question, a researcher for each angle, and a verifier briefed to disprove. A report lands when the person who asked accepts it. |

The package `oats.engineering` is frozen at `v1.18.0`. Its entry and its four
aliases stay, so existing pins keep resolving, and its repository,
`oats-project/oats-engineering`, gets no further releases. The engineering
template that replaces it lives in its own repository, above; a workspace that
pins the package moves to it by the template's `ADAPTING.md` and the "From
v1.18.0" steps in its CHANGELOG. Open: retiring the entry and moving the
aliases, a later decision once no workspace we know of pins it.

## Find and use packages

- A workspace pins an official package by **bare version** in its
  `packages:` map (`oats.okf: v5.8.0`); `oats sync` resolves it through the
  catalog to an exact commit, fetches it, verifies its integrity and locks it.
  A package outside the catalog is written `git:<repo>@<ref>`. Pinning does
  not join a team or adopt the publisher's workspace. See
  [packages](packages.md).
- **Discoverable ≠ declared.** A catalog listing grants nothing; a
  `packages:` pin is the workspace's decision to trust that package at that
  version, and the lock pins it to an exact commit and integrity. Nothing is
  installed.
  Official status never grants trust, credentials or permission to run code.
- Listing also does not prove that every harness, provider combination or
  deployment profile is supported. Check the package's declared compatibility,
  requirements and current readiness limits.

## How a package becomes official

1. Publish a source-complete release and open a PR to `package-catalog.json` in
   `awebai/oats`, giving the package's URL, immutable tag ref and payload path.
2. Include evidence for the acceptance criteria below. External packages go
   through the same process as packages maintained in the OATS repositories.
3. An OATS maintainer reviews the entry, its exact release and trust posture.
   Officialness follows the reviewed list change, not an unmerged proposal.

### Acceptance criteria

- **Complete source:** a valid `oats-package.json` at the declared payload root,
  with all exported capabilities, instructions, skills, references and required
  runtime files contained in the supported package closure.
- **Immutable release:** a real published tag resolving to the reviewed commit,
  with reproducible payload/integrity evidence. Do not list a floating branch,
  invent a future ref or move an already published tag.
- **Valid declarations:** capability manifests validate against the supported
  schema and state truthful identities, compatibility and requirements.
- **Honest execution surface:** commands, hooks, launch environment and other
  executable contributions are declared accurately. Review their effects: a
  workspace that declares the package trusts exactly the locked version, not
  its official name.
- **Maintainership:** a documented, reachable maintainer contact or maintained
  issue/security-reporting route.
- **License:** clear redistribution terms for the package and its dependencies,
  with required license notices included in the distributed payload.
- **No secrets:** no credentials, signing keys, tokens or private instance state;
  only supported nonsecret configuration and credential references where needed.
- **No hidden prerequisites:** host/runtime requirements use the supported
  manifest fields; external services, network access and operator setup/consent
  are documented. Do not conceal an installation or host mutation in setup code.

Contact and license evidence may live in the package/repository documentation;
this policy does not invent new catalog or manifest fields.

## Updates, deprecation and removal

Use the same catalog PR and maintainer-review path to update, deprecate or remove
an entry. State the reason, affected releases and supported replacement or hold,
and assess existing locks before changing discovery. Preserve immutable
release history. A list change is not permission to rewrite a deployment's
lock or change what a workspace declares.
