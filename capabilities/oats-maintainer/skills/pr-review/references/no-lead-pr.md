# A PR with no lead: the four gates

<!-- OATS: decided 17 Nov 2026 (oats#1943): the release lane's sign-off reads every PR it signs off by these four gates. -->
Here the release lane's sign-off reads every PR it signs off by these four gates too, at
the exact head being merged, as the final gate on main (`SKILL.md`, "Which PRs, and
when"), whatever reviews the PR has had.

An outside contributor's PR, or a person's own, has had none of our reviews. It is ready
when its author marks it ready (not a draft) or asks for a read at a named head, with CI
green. For a fork, check the workflows and secrets (gate 3) first, so CI can run. Read
the author's evidence at this head, then:

<!-- OATS: decided 17 Nov 2026 (oats#1943): gate 1 judges direction, roadmap and product fit. -->
1. **Direction, roadmap and product fit** (`/direction-gate`), against the full diff: it
   belongs where it is, moves the lane the way its roadmap and recorded decisions say,
   and fits the product (who it is for, what it is meant to be).
2. **Correctness.** Read the whole diff, from an exact-commit checkout of your own, never
   another agent's work tree. Find the consumers of every changed export, signature,
   output or message shape, config key, flag, error code and file format, here and in
   the repositories that depend on it, and read how each uses it. A behaviour change
   updates its tests in the same change; an assertion is never weakened to make it pass.
3. **Security.** Data becoming execution (commands, paths, queries, templates), trust and
   integrity checks, path containment, identity and authorisation, secrets, rendering of
   user content. Also:
   - **Forks and first-time contributors:** CI that would run their code with secrets or
     write permissions, and any change to workflows, permissions or secrets handling, is
     reviewed before CI runs it.
   - **Dependencies:** each new or bumped one is a supply-chain change. Check that it is
     needed, where it comes from, that it is pinned, and that its lockfile change matches
     the manifest change and nothing else.
4. **Mergeability.** The head, base and checks are the ones you reviewed; no conflicts
   (the author resolves them); no unresolved thread, with other reviewers' and bots'
   comments answered; not a draft; docs and release notes cover it; it is in the next
   release's plan. A PR too large to review well is split first.

The verdict goes on the PR, bound to the SHA, where its author reads it: `GREEN LIGHT at
<sha>` naming the four gates, `RETURN` with prioritised findings (each with file, line
and how to reproduce), or `ESCALATE`. Only correctness, safety, direction and
coherence-rule findings block; record the rest as follow-ups. Where the forge refuses
your approval (your own PR, a shared account), the comment with the verdict and the SHA
stands.

Then it lands as your landing rules say for a PR with no lead: where they give you the
merge, merge that head ([reviewed-delivery.md](reviewed-delivery.md), "Merge"). A fix
its author won't make goes to a lead, which decides who builds it.
<!-- OATS: the lane map's second reader and the release lane's sign-off bind every PR, release prep included. -->
Your own release prep needs no review round and you never approve it yourself, but here
it still gets its second reader (the one the lane map names for the release lane's own
PRs) and, where its lane's line asks, the release lane's sign-off, at its head, before it
merges.
