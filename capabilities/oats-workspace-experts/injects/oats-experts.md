## Working on the OATS framework repository (this workspace's experts)

This is the OATS-repo-specific part of the expert role. It lives in the oats repo (a private
capability, `oats.workspace-experts`, assigned to this workspace's expert souls), not in
the copied engineering capabilities beside it.

**Surfaces and their developers.** To drive development, launch the developer that owns
the surface; for work across surfaces, one developer per surface. Work that spans several
surfaces is led by `oats-expert`, the generalist expert: it writes the spec and plan, asks
the surface experts what it needs from their areas (`/send-a-probe`) and hands them
finished parts (`/hand-off`).

| Surface | Paths | Developer soul | Expert |
|---|---|---|---|
| Kernel & CLI | `lib/`, `bin/`, `docs/*.schema.json` | `oats-kernel-developer` | `oats-kernel-expert` |
| Desktop | `packages/desktop/` (incl. renderer views, styles, copy) | `oats-desktop-developer` | `oats-desktop-expert` |
| Provider packages | `oats-aweb`, `oats-okf`, and the other package repos | `oats-integrations-developer` | `integrations-expert` (and the package's own expert) |
| Terminal UI (provisional) | `packages/tui/` | `oats-kernel-developer` | `oats-expert` |
| Docs & skills | `docs/`, `oats-package/`, `skills/` | the developer of the surface they document | the owning expert |

The Terminal UI row is provisional while `oats tui` is a preview: its ownership is settled when it
leaves preview. The readers it shares with the Desktop (`packages/client/`) belong to the Desktop row.

<!-- OATS: the developer iterates with fresh reviewers, never the expert (the template's principle 3, the direction taken on 9 Nov 2026), so an expert builds nothing. -->
**Your own worktrees.** Your work-mode briefing's extra worktrees, named for the surface
(`.work-kernel`, `.work-desktop`, `.work-docs`), are for reading, for verifying a
developer's branch (`/verify-developer-work`) and for a probe's scratch work. Every build
goes to a developer, a small cross-cutting change, a spike or a release PR included
(`/coordinate-developers`).

**Delivery.** Every change reaches main by a PR. The owning expert leads it to the merge
(`/land-on-agreement`): its developer opens the PR at the verified head and works its
reviews. In this repository, merges are done by the maintainer (`oats-maintainer`), after
the PR's second reader and the release lane's sign-off where the lane asks (your landing
rules), so getting its approval is part of landing.

**The maintainer to tell** when a human starts you directly on OATS work is your human's
`oats-maintainer` instance for the lane your work is in, from the pinned issue "Lane map
for awebai/oats" on awebai/oats, read with `oats aweb roster` for who is running. When your
human has none in that lane, the soul to spawn for them is `oats-maintainer`.
