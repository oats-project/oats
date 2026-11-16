# The landing rules: who builds, before a build, PRs with no lead, records

## Who builds, and the review every change gets
- Whoever specifies a piece of work decides who builds it: itself, or a developer, which
  earns its place by protecting context, building in parallel or specialising. A large
  feature always goes to developers. The spec comes first, with pinned acceptance tests.
- Whoever builds iterates with a fresh `code-reviewer`, its OATS child, until a round
  finds nothing to fix: at least one round, and never the author reading its own work.
  Whoever specified a developer's work verifies its converged branch once, and runs no
  rounds for it.
- After 4 fresh rounds without a clean one, the builder's parent decides each open
  finding, and the person where it can't.
<!-- adapt: May a change land with no fresh review (a typo, a broken link)? -->
- **A one-line docs fix** (a typo, a broken link) skips the local loop, not the review:
  it merges on CI green and one fresh review at its head, the review bot's where one
  runs, otherwise one reviewer round. Its PR opens once the fix is proven the way the
  repository checks its docs, before that review; a developer's gets its expert's
  `VERIFIED` after the review, before the merge. If that review finds anything to fix, it is no
  longer a one-line fix: it gets the loop.
- **A maintainer's release prep** (the version bump and the assembled notes, nothing
  more) is the one change that needs no review round.

Why: the builder holds the context to answer its reviews, and a fresh reader catches what
its author can't.

## Before a build
Where a lane asks for a maintainer's green light, a contract or direction question goes
to that maintainer before the change is built, so its green light holds no surprise.

## A PR with no lead
An outside contributor's, a person's own, or a maintainer's release prep. The lane
owner's maintainer merges it at its head once CI is green and the review bot's review
holds where one runs; it reads any but its own release prep first, by its four gates. A
fix goes to a lead, which decides who builds it. A running maintainer finds such a PR in
its intake; until one runs, the person brings it to their dispatcher, which starts one.
Why: someone here has to own the merge, and the lane's maintainer holds it.

## Records
Where your briefing says they are kept:
- **An effort record:** one item per effort, its status at the top, in words a person can
  read cold: what it is, where it stands, who is on it (instance and seat), what waits on
  whom. It also holds what your tasks layer's items never do: the specialists and their
  areas, the interfaces agreed between them, the probes and what each found.
- **A hold:** on the PR it holds, or one open record for the default branch, naming its
  reason, its scope and who lifts it. Every merge step reads the open holds first.
- **A finding outside your work:** one record, sent to its area's owner.

## After a change to these rules
Whoever wrote the change messages each standing instance (the dispatchers, the
maintainers) and the lead of each open effort, with the change at its commit. Each lead
tells its running children: its specialists, developers and helpers. Each recipient
records the change, at its commit, in its state file (a lead on its effort's record
too), and from then on reads these rules with the changes it recorded, compaction or
not.
