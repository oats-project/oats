# Framework capability payload

The **oats.framework** package: the Git-distributed payload that ships six
independently selected capabilities, all resource-only but `oats.core`, and
two package souls, `knowledge-theory-expert` and `oats-setup-expert`. Package
identity and
version live in `oats-package.json`; each capability's identity, version and
floor live in its own `oats.json`. The package root is `oats-package/`, not the
npm root; the kernel npm tarball does not contain it.

| Capability | Resources | Authority |
| --- | --- | --- |
| `oats.core` | `oats-operate`, `oats-souls`, `oats-token-saving`, and the "You run on OATS" inject | How an agent works inside an instance, and how it keeps messages to other instances few and short; its hooks write a Claude instance's waiting hooks and adopt a home that `oats instance upgrade` moves; no commands, and not a core capability |
| `oats.setup` | `oats-setup-model`, `oats-onboarding`, `oats-setup-expert`, `oats-host-delivery`, `oats-agent-permissions`, `oats-git-setup`, `oats-workspace-config`, `oats-teams`, `oats-package-pins`, `oats-automations`, `oats-upgrade`, and the setup inject | How an operator understands, realizes, configures and upgrades a workspace and a deployment; no automatic provisioning |
| `oats.onboarding` | `oats-tailor-workspace` (the package soul `oats-setup-expert` uses it) | How the setup expert turns OATS's defaults into a new workspace's own coordination, knowledge and tasks capabilities; procedure only, no inject |
| `oats.coordination-setup` | `coordination-best-practices`, `adapt-to-the-organisation`, `design-the-roster`, `set-landing-rules`, `review-the-setup`, and the coordination-setup inject (the package soul `oats-setup-expert` uses it) | How the setup expert shapes OATS's coordination practices to an organisation: its roster of souls, its landing rules and its ownership record across people; resource-only, proposes for the people's yes |
| `oats.support` | `support-intake`, `support-safety`, `support-ticket`, `support-handoff`, `support-relay`, and the support inject | The support desk role: tickets requests and hands them to the project's support maintainer; never changes code, reviews, merges, releases or deploys |
| `oats.knowledge-theory` | `knowledge-capability-authoring` with its complete local references (the package soul `knowledge-theory-expert` uses it) | Optional authoring theory; no mandatory runtime doctrine, harvester or OKF dependency |

## How a workspace selects them

A workspace pins the package once and souls name capabilities by source, never
by version (`docs/workspaces.md`):

```yaml
# oats-workspace.yaml
packages:
  oats.framework: <version>        # a bare version resolves through package-catalog.json
defaults:
  capabilities:
    oats.core: { from: package }   # every soul gets the operating guidance
```

```yaml
# souls/<operator soul>/soul.yaml
capabilities:
  oats.setup: { from: package }    # only souls that set up deployments
```

In the standalone view (a member whose workspace host the operator cannot
read) `oats.core` is the kernel's default, resolved from the catalog through
the operator's own lock. Either way the package is locked like any other, and
declaring it is the trust decision; its capabilities add no commands or hooks.

## What the skills teach, and from where

- `oats.core` teaches the instance's two directories, work modes, what was
  materialized into the home, drift, the read-only views, spawning with a
  declared relation, and acting on other instances (such as retiring
  instances it spawned) only when told to.
- `oats.setup` explains the setup model, then gives the procedure for
  onboarding, workspace config, teams, package pins and automations. The
  judgement behind each step is the operator knowledge node
  (`oats/oats-operator-expert`), cited by concept name; the contract is the
  kernel's shipped `docs/` (`workspaces.md`, `configuration.md`,
  `packages.md`, `schedules.md`), read from the installed kernel so it always
  matches the running version.
- Every `oats` command and flag the core and setup skills show is checked
  against the shipped CLI by `test/operational-skills-cli.test.mjs`.

## Maintainers

`node scripts/check-knowledge-theory-package.mjs` is the manifest/inventory
gate for all its capabilities and package souls; `--write` only synchronizes the theory
references from canonical docs. The optional theory curriculum begins at
[the local authoring guide](capabilities/oats-knowledge-theory/skills/knowledge-capability-authoring/references/knowledge-capability-authoring.md).
Git preserves each package soul's `CLAUDE.md -> AGENTS.md` alias;
acquisition must not synthesize an alias missing from a partial copy.
Publishing a new package version and its catalog entry is release work: never
claim a version that the catalog does not list.
