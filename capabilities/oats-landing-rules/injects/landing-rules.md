## Landing rules: how work lands here

These are this organisation's landing rules and its ownership record, in one place. Every
coordinating role reads them here: the dispatcher, the experts, the developers and the
maintainers. Where a skill says "your landing rules", it means this section. They change
only on the yes of the person who owns the lane, each rule with its reason (where the
workspace has oats.framework's `oats.coordination-setup`, its set-landing-rules skill
writes them); a lane opened on the lane map for its
owner's own work runs on the defaults below until then. No rule sets a deadline or a default
if someone is silent: a request waits for its answer. These rules are copied into each
instance at spawn: after a change, whoever wrote it tells each standing instance (the
dispatchers, the maintainers) and the lead of each open effort (the effort records name
them) by message, with the change at its commit; each lead tells its developers. Each
recipient records the change, at its commit, in its state file (a lead on its effort's
record too), and from then on reads these rules with the changes it recorded, which win,
compaction or not.

**Lanes and their owners.**
<!-- adapt: Which lanes does the organisation have, what does each cover, and which person owns each? -->
- `main`: everything in this workspace's repositories, owned by the person who runs the
  workspace. It is also the release lane.

**CI green,** wherever these rules or a skill say it, means every check the forge requires
at a head has succeeded there: none failing, none pending.

**What merges a change, and who merges it.**
<!-- adapt: Per lane, which agreements must hold at a PR's head before it merges, and who merges it? -->
In every lane, at one head: CI green; a review; and the lead's verification note,
`VERIFIED at <head>`. The review is the forge's review bot's at that head where one runs,
each of its findings fixed or answered (a decline with a concrete reason is answered);
otherwise a round of the developer's review loop that found nothing to fix, with a fresh
reviewer at that head. Either carries to a new head only through a rebase whose range-diff
shows every commit unchanged, or an update from the default branch that leaves the PR's own
diff unchanged; any other new head gets a fresh round, or a new review the
developer asks the bot for at that head where it doesn't review each push by itself. The
lead merges. Why: three independent checks at the same head, and the one who owns the whole
effort lands it.

**The green light to open a PR.**
<!-- adapt: Who gives the green light to open a PR at the verified head? -->
The lead's verification note. The developer then opens the PR at that head and works its
reviews. Why: the lead holds the design, and nothing else needs to happen before review.

**Who builds a change.** A developer builds every change, with a spec and pinned
acceptance tests, and iterates with a fresh reviewer each round until a round finds nothing
to fix; the lead verifies the converged branch once, and never runs review rounds or spawns
reviewers.
<!-- adapt: May a lead make a one-line docs fix itself, with no review loop? -->
A lead may make a one-line docs fix itself (a typo, a broken link), with no review loop. It
is no exception to who iterates with reviewers: nothing in it needs a review round. It
merges on CI green, the review bot's review where one runs, and the lead's note. If the bot
finds anything to fix, it is no longer a one-line fix: it goes to a developer. Why: the one
who built a change holds the context to answer its reviews, and a one-line fix isn't worth
a developer.

**A maintainer's read, and releases.**
<!-- adapt: Where does the organisation require a maintainer's read, keep the merge for a maintainer or a person, and who releases? -->
No lane needs a maintainer's read. A release's contents are approved by the owners whose
lanes have changes in it; the release lane's maintainer plans, tags and publishes it,
started when first needed. Why: a maintainer holds what a lead wouldn't, and is called only
for it.

**A PR with no lead here:** an outside contributor's, a person's own, or a maintainer's
release prep (the version bump and the assembled notes, nothing more). The lane owner's
maintainer merges it at its head once CI is green and the review bot's review holds where
one runs; it reads any but its own release prep first, and approves at that head. Release
prep needs no review round, like a lead's one-line docs fix, and is no exception to who
iterates with reviewers: nothing in it needs one. Any fix goes to a lead and its developer.
A running maintainer finds such a PR in its intake; until one runs, the person brings it to
their dispatcher, which starts it. Why: someone here has to own the merge, and the lane's
maintainer holds it.

**One-way doors kept for people.**
<!-- adapt: Which acts must a person approve, beyond a release's contents? -->
A release's contents, publishing outside the organisation, spending money, and deleting
what someone else uses. Nothing else goes to a person by rule.

**The ownership record.** With one person, they own every path and lane.
<!-- adapt: With more than one person, who owns which paths and lanes? -->
- (one line per area: its paths, and the person who owns them)

**Where things are kept.** These rules are copied into each instance at spawn, so what
changes while work runs is kept where everyone reads and updates it live.
<!-- adapt: Where are the effort records, the lane map and holds kept? -->
- the effort records: one item per effort in your tasks layer, its status at the top;
- the lane map, with one entry per maintainer: one record in your tasks layer, created
  empty when these rules are adapted, at: (its link). A maintainer adds its own entry;
- a hold: marked on the PR it holds, or, for the default branch, one open record next to
  the lane map, each with its reason, its scope and who lifts it.
