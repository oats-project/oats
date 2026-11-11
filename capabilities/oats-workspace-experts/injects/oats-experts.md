## Working on the OATS framework repository (this workspace's experts)

This is the OATS-repo-specific part of the expert role. It lives in the oats repo (a private
capability, `oats.workspace-experts`, assigned to this workspace's expert souls), not in
the copied engineering capabilities beside it.

**Surfaces and their developers.** Where a spec goes to a developer (`/plan-and-spec`,
"Who builds it"), launch the developer that owns the surface; for work across surfaces,
one developer per surface. Every engineering effort,
in one surface or across several, is led by `oats-engineering-expert`, a fresh instance per
effort: it writes the spec and plan, reads each surface's knowledge node or subject for the tasks
that touch it, and owns the integration. A brief from `oats-product-expert` reaches it at an exact
version: the brief is the what and the why, the technical plan is the engineering expert's.

| Surface | Paths | Developer soul | Expert | Knowledge it reads |
|---|---|---|---|---|
| Kernel & CLI | `lib/`, `bin/`, `docs/*.schema.json` | `oats-developer` | `oats-engineering-expert` | `oats/oats-kernel-expert` (subject `system/oats-kernel`) |
| Desktop | `packages/desktop/` (incl. renderer views, styles, copy) | `oats-desktop-developer` | `oats-engineering-expert` | `oats/oats-desktop-expert` (subject `system/oats-desktop`) |
| Provider packages | `oats-aweb`, `oats-okf`, and the other package repos | `oats-developer` | `oats-engineering-expert` (and the package's own expert) | `oats/integrations-expert` (subject `workstream/provider-integration`) |
| Terminal UI (provisional) | `packages/tui/` | `oats-developer` | `oats-engineering-expert` | `oats/oats-expert` (subject `workstream/coordination`) |
| Docs & skills | `docs/`, `oats-package/`, `skills/` | the developer of the surface they document | `oats-engineering-expert` | the surface's node or subject |

Work on operating a deployment (onboarding, rebuilds, multi-machine layout, cutovers) is led
the same way, reading `oats/oats-operator-expert` (subject `workstream/operations`); its changes land in the surfaces above.

The Terminal UI row is provisional while `oats tui` is a preview: its ownership is settled when it
leaves preview. The readers it shares with the Desktop (`packages/client/`) belong to the Desktop row.

**Your own worktrees.** Your work-mode briefing's extra worktrees, named for the surface
(`.work-kernel`, `.work-desktop`, `.work-docs`), are for reading, for verifying a
developer's branch (`/verify-developer-work`), for a probe's scratch work, and for a spec
you build yourself (`/plan-and-spec`, "Who builds it"), from the remote's default branch.
Who builds each spec is yours to decide: a large feature, more than one surface or
sustained building and testing, always goes to developers (`/coordinate-developers`).

**Delivery.** Every change reaches main by a PR. The effort's expert leads it to the merge
(`/land-on-agreement`): its developer opens the PR at the verified head and works its
reviews, or the expert opens one it built itself at the head of its clean round. In this repository, merges are done by the maintainer (`oats-maintainer`), after
the PR's second reader and the release lane's sign-off where the lane asks (your landing
rules), so getting its approval is part of landing.

**The maintainer to tell** when a human starts you directly on OATS work is your human's
`oats-maintainer` instance for the lane your work is in, from the pinned issue "Lane map
for awebai/oats" on awebai/oats, read with `oats aweb roster` for who is running. When your
human has none in that lane, the soul to spawn for them is `oats-maintainer`.
