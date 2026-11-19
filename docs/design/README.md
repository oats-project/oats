# Design records

Dated records of decisions that are still in force: the context, the decision
and its consequences. The current behaviour is explained in the reference pages
([workspaces](../workspaces.md), [packages](../packages.md),
[configuration](../configuration.md), [souls and instances](../souls-and-instances.md),
[capabilities](../capabilities.md), [knowledge](../knowledge.md)); when a record and
a reference page disagree, the reference page wins. Superseded records are
deleted; [HISTORY.md](HISTORY.md) lists each one, its decision and its
successor, with a link to its full text.

- [Workspace module contracts](2026-09-23-workspace-module-contracts.md): the
  normative contracts of `lib/remote.mjs`, `lib/workspace.mjs`, `lib/resolve.mjs`,
  `lib/packages.mjs`, `lib/materialize.mjs` and the CLI verbs built on them.
- [Knowledge and messaging capability contract](2026-09-16-knowledge-capability-contract.md):
  the kernel supplies contracts; capabilities own knowledge and messaging behaviour.
- [OKF knowledge operations](2026-09-26-okf-knowledge-operations.md): package
  souls, triggers and automations for harvest and maintenance.
- [Team model v2](2026-09-27-team-model-v2.md): shared teams in the workspace,
  local teams, live teams and the provider environment (its membership and
  default-team parts are superseded by team model 3).
- [Team model 3](2026-10-02-team-model-3.md): the teams a soul may join, and
  its default, are committed in the workspace; local teams only where the
  workspace allows them.
- [Module upgrade](2026-10-22-module-upgrade.md): `oats instance upgrade` moves
  a stopped home's package modules to the locked versions, with plan, apply,
  provider adoption and undo (supersedes workspace model v2 items 10–11 for
  package modules).
- [The warm reader](2026-10-29-warm-reader.md): `oats reader --stdio`, a
  child the Desktop and the TUI start, answers `oats status` and `oats
  workspace status` with the kernel's own read code kept loaded: warm code,
  not warm data, the same answers as the CLI, and the CLI as the fallback.
- [Sandboxes](2026-11-19-sandboxes.md) (proposed): boundaries declared in
  the workspace's `sandboxes:`, started by `oats sync` on the machines that list
  them; the contracts both sides decide before it is built.

The Desktop's design brief for designers is in
[packages/desktop/docs](../../packages/desktop/docs/design-brief.md).
