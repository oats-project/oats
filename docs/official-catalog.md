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
| `oats.engineering` | `v1.18.0` | `oats.engineering-expert`, `oats.developer`, `oats.code-review`, `oats.maintainer` | `code-reviewer` |
| `oats.authoring` | `v1.0.3` | `oats.authoring` | |
| `oats.cloning` | `v1.1.0` | `oats.cloning` | `cloner` |
| `oats.jira` | `v1.0.1` | `oats.jira` (tasks) | |
| `oats.linear` | `v1.0.1` | `oats.linear` (tasks) | |
| `oats.apps` | `v1.0.0` | `oats.folio`, `oats.library` | |
| `oats.machine` | `v0.1.1` | `oats.machine-care` | `steward`, `technician` |

Each package lives in its own `awebai/oats-*` repository except
`oats.framework`, whose payload root is `oats-package/` here. A capability id
names the package that supplies it through the catalog's aliases, so
`oats.developer: { from: package }` selects `oats.engineering`. This catalog ships with
the CLI: an older installed CLI keeps its own copy, and a change here rewrites
no lock and adds nothing to an existing workspace.

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
