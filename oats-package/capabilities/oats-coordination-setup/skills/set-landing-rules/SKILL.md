---
name: set-landing-rules
description: >-
  Write an organisation's landing rules from how it lands changes today: per
  lane, the agreements that merge a change and who merges; who gives the green
  light to open a PR; who builds (the lead or a developer), its author running
  the review rounds and nothing landing without a fresh review; where a
  maintainer's read is required and whose it is; the one-way doors kept for
  people; and a merge path every lead can reach, with no deadlines and no
  defaults. Use at onboarding, and when the setup is reviewed. Part of
  oats.coordination-setup.
---

# Set the landing rules

1. **Read what holds today:**
   - required reviews and who may merge;
   - branch protection, rulesets and CI;
   - signed commits, and whose account agents commit under;
   - each repository's own pre-PR review;
   - the release process, and what people sign off now.
2. **Per lane, name the agreements that merge a change, and who merges.**
   Default: CI green and the review at the head, the author's last fresh
   reviewer finding nothing to fix (on a different model where the
   organisation has one), plus, for a developer's work, the lead's
   verification note at that head; the lead merges. A change the lead built
   has no verification note: its clean round stands in. A review carries to a
   new head with no re-read through an unchanged rebase or update, and through
   the same reviewer's re-read of a delta that only fixes a minor, takes a nit
   or fixes CI with no change in behaviour; otherwise not, and a blocker's or
   a major's fix gets a fresh reviewer. The reviewer's severity decides. Where
   the organisation keeps the merge for its people, say so: agents then hand
   them a PR at an exact head.
3. **Every lane names a merge path a lead can reach.** A lead with no
   agreement it can meet stacks up PRs, specs and mail. Where today nobody but
   a person can merge, propose the smallest agreement that lets an agent
   merge, such as an independent approval at the head, for the person's yes.
4. **Who builds and who opens the PR.**
   - The lead decides who builds each spec: itself, or a developer where one
     protects its context, builds in parallel or specialises in a lane of its
     own (`/coordination-best-practices`, "One lead per effort"). Whoever
     builds a change runs its review loop, a fresh reviewer each round until a
     round finds nothing to fix, and never reads its own work as its review;
     the lead verifies a developer's converged head once and never runs
     rounds for it.
   - Nothing lands without a fresh review. A one-line docs fix (a typo, a
     broken link) skips the local loop, not the review: it merges on CI green
     and one fresh review at its head. Only a maintainer's release prep needs
     no review round. Where every commit must pass a review round (commits
     signed under a shared account, a repository's own pre-PR review), the
     docs fix gets that round too.
   - Who gives the green light to open a PR: for a developer's work, the
     lead's verification at the verified head where that is enough,
     otherwise whoever holds the lane; for a change the lead built, the round
     that found nothing to fix. The author then opens it and works its
     reviews. A helper building a scoped piece of its parent lead's effort
     hands that head back and opens no PR until the parent has verified it.
5. **A maintainer's read** only where the organisation already requires a
   second read for a lane, or reserves its merges. It is the maintainer of the
   person who owns the lane. Say whether the maintainer reads or merges. When
   first needed and none is active, the lead starts it for its own person,
   without asking, and tells them in two or three plain sentences what a
   maintainer is, what it is for, and its exact name; for another person's
   lane, through that person's dispatcher, or that person.
6. **The one-way doors** a person must open: those the organisation keeps
   today, such as a release's contents, publishing outside the company, money,
   and deleting what others use. Nothing else goes to a person by rule.
7. **No deadlines and no defaults.** A request waits for its answer.
8. **Hand them on.** From `/adapt-to-the-organisation`, the rules go into its
   card for each person and its write step; write nothing here. From
   `/review-the-setup`, propose the change as one card to the person who owns
   the lane, and on their yes write it into the landing-rules capability, with
   its reason.
