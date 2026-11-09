---
name: set-landing-rules
description: >-
  Write an organisation's landing rules from how it lands changes today: per
  lane, the agreements that merge a change and who merges; who gives the green
  light to open a PR; who builds and who runs the review rounds; where a
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
   Default: CI green and the approval of the developer's last fresh reviewer
   at the head (on a different model where the organisation has one), plus the
   expert's verification note at that head; the expert merges. Where the
   organisation keeps the merge for its people, say so: agents then hand them
   a PR at an exact head.
3. **Every lane names a merge path a lead can reach.** A lead with no
   agreement it can meet stacks up PRs, specs and mail. Where today nobody but
   a person can merge, propose the smallest agreement that lets an agent
   merge, such as an independent approval at the head, for the person's yes.
4. **Who builds and who opens the PR.**
   - A developer builds every change that needs review rounds, and launches a
     fresh reviewer for each round; the expert verifies the converged head
     once and never runs rounds. A lane may let a lead make a one-line docs
     fix, or a maintainer its release prep, with no review loop; write each
     as that exception, not as a lead that builds. Where every commit must
     pass a review round (commits signed under a shared account, a
     repository's own pre-PR review), there is no such exception.
   - Who gives the green light to open a PR at the verified head: the
     expert's verification where that is enough, otherwise whoever holds the
     lane. The developer then opens it and works its reviews.
5. **A maintainer's read** only where the organisation already requires a
   second read for a lane, or reserves its merges. It is the maintainer of the
   person who owns the lane. Say whether the maintainer reads or merges. When
   first needed, the lead starts it for its own person; for another person's
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
