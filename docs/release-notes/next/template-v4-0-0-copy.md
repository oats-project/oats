## Changed

- **OATS's own copy of the engineering template moves to template-v4.0.0,
  taken up whole.** The template recomposed every text, so the copy is
  template-v4.0.0's text with OATS's answers and its marked adaptations
  written back in. This changes the texts this workspace's own souls are
  composed from, not the kernel or any package contract.
  - **One agent is the default,** and every expert instance holds one seat,
    named on a `Seat:` line in its task: root lead, specialist, or helper or
    probe. A lead sizes the tree to the work: alone, with short-lived probes
    and helpers, or with one long-lived specialist per area for a large
    effort or one across several areas.
  - **Skills renamed or folded in.** `oats.engineering-expert` has five
    skills: `/plan-and-spec`, `/orchestrate-agents` (was `/send-a-helper`),
    `/coordinate-developers` (takes in `/verify-developer-work`),
    `/hand-off-and-ask` (takes in `/hand-off`, `/ask-a-person`,
    `/findings-and-blocks` and `/across-people`) and `/land-on-agreement`
    (takes in `/find-the-maintainer`). `oats.build` has three:
    `/build-in-the-repository` (new), `/run-the-review-loop` and
    `/work-the-reviews`; `/test-first`, `/diagnose-before-fixing`,
    `/design-while-writing`, `/execution-strategy`, `/prove-it-works`,
    `/maintain-dev-docs` and `/worktrees` are gone. `oats.developer` folds
    `/understand-the-spec` into its briefing. `oats.maintainer` has
    `/keep-the-lane` (from `/maintainer-intake`, `/keep-it-clean` and
    `/cross-review-peer`), `/plan-and-ship-release` (from `/plan-release`
    and `/ship-release`), `/pr-review`, `/direction-gate` and
    `/launch-work`; it still drops `/support-maintainer`. `oats.landing-rules`
    gains `/landing-rules-detail` and `/wait-and-retire`, which every
    coordinating soul now has. The souls' own texts name the new skills.
  - **A lane maintainer's green light.** In the template it is an option a
    lane chooses. Every OATS lane asks for it: the maintainer's read of a PR
    from an effort is now its verdict at the exact head, `GREEN LIGHT`,
    `RETURN` or `ESCALATE`, on direction, contracts, coherence, scope and
    evidence. Each lane's agreements are as before: the PR's second reader,
    the release lane's sign-off where the lane asks, and the merge where the
    lane's arrangement puts it. A PR with no lead still gets the four gates.
  - **Both maintainer reads look at the code and judge direction, roadmap
    and product fit.** The lane maintainer's green light adds its own read
    of the whole diff, from its own checkout, to the five checks: a defect
    it finds there blocks, and it runs no review rounds of its own. The
    release lane's sign-off keeps the four gates (direction, roadmap and
    product fit; correctness over the whole diff; security; mergeability)
    on every PR it signs off, at the exact head being merged, as the final
    gate on main.
  - **What carries to a new head.** A review carries as before, except that a
    fix to a minor is read by the review bot where one runs, otherwise by a
    fresh reviewer briefed with the delta, not by the round's reviewer. A `VERIFIED` note and a green light carry only
    through an unchanged rebase or update; at any other head, whoever gave
    one reads the delta and gives it again.
  - **Every finished instance retires itself,** its children first
    (`oats retire <name> --self`), and its parent checks that it is gone and
    retires one still listed. A reviewer retires itself once its report is
    sent: one reviewer, one report.
  - **OATS keeps its lane map.** The template drops it; OATS's landing rules
    still point at the pinned issue "Lane map for awebai/oats" for its lanes,
    their owners and arrangements, and a lane's maintainer is found by its
    `active` entry there. Maintainers keep their instance names.
  - The model floor, the hosts rule and CI as the test run are stated once,
    in the landing rules' house rules.

  A running instance keeps the texts it was spawned with: composition is
  frozen at spawn, so no running instance changes, and a new spawn takes
  these. `capabilities/TEMPLATE-RELEASE` records the release and its commit.
  The catalog's row for the engineering template moves to template-v4.0.0.
- **`oats.framework`'s setup expert teaches the green light as an option.**
  `/set-landing-rules` offers a lane maintainer's green light per lane, off by
  default: recommended for a large project (several lanes or maintainers,
  several people), left out for a small personal project. Its carry rule
  follows template-v4.0.0. `/adapt-to-the-organisation` and
  `/design-the-roster` write no lane map: the landing rules list the lanes and
  their owners, and a maintainer is found by its instance name,
  `<person>-<lane>-maintainer`.
