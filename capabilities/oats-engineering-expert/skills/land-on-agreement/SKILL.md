---
name: land-on-agreement
description: Takes a PR from a verified branch to merge - the VERIFIED note for a developer's work or the clean round for a change the lead built, a lane maintainer's GREEN LIGHT at the exact head where the landing rules ask for one (finding that maintainer by its instance name, or starting one where none exists), the merge at that head by whoever the landing rules name, a conflict with the default branch, a release, and saying shipped only once checked. Use whenever work becomes a PR, while a PR is open, before every call to a maintainer (a green light, a direction answer before a build, a release), and when a PR merges.
---

# Land on agreement

Your landing rules, in your briefing, name per lane the agreements that merge a change
and who merges; `/landing-rules-detail` defines each. Read them once per effort and again
after a compaction. A change to them you recorded since wins. With none in your briefing,
merge nothing: that is a block (`/hand-off-and-ask`).

## 1. To an open PR
- **A developer's work, or a helper's scoped piece:** verify its converged branch once
  (`/coordinate-developers`) and send `VERIFIED at <head>`, with the reviews the lane
  counts. The developer opens the PR and works its reviews. Once the PR exists, post your
  note on it: `VERIFIED at <head>: <the checks you ran>`.
- **A change you built:** the round of your review loop that found nothing to fix stands
  in for a verification. Open the PR at that head and work its reviews
  (`/work-the-reviews`).
- **A one-line docs fix** skips the local loop, not the review: `/landing-rules-detail`
  has its order. A developer's gets your `VERIFIED` after its one review.

When a developer hands the PR back ready, read what changed since your verified head.
Verify again only where the change touches the design (the architecture, a contract, a
recorded decision); otherwise post `VERIFIED at <new head>: delta since <old head> read,
no design change`. A decline with a concrete reason answers its finding: return one only
where it touches the design or a contract.

## 2. The maintainer's green light
Only where your landing rules ask for it in the PR's lane; a lane they don't name needs
none. As a specialist, this step is yours for your area's PRs.

**Find the maintainer** by its instance name: the person who owns the lane, the lane,
then `maintainer`. [references/find-the-maintainer.md](references/find-the-maintainer.md)
says how, what to do when it is stopped, and how to start one where none exists. Never
start a second maintainer for a lane while one exists, even a stopped one.

**Call it** by message, once CI is green and every review thread is answered at one head,
with what it judges from: the PR at that head, the task it delivers with its acceptance
criteria, your `VERIFIED` note or your clean round's Checked section, what was run, and
the findings declined, with why.
- **`GREEN LIGHT at <head>`:** go on to the merge. As a specialist, send your parent the
  PR at its head with the green light: a hand-off to a person is the root lead's.
- **`RETURN at <head>`:** its findings go to the change's author, and the fixed head goes
  back to the maintainer. After 3 returns on one PR, stop: the root lead puts both
  positions, each with its evidence, to its person in one card.
- **`ESCALATE`:** a direction question went to whoever decides it. Wait for that answer;
  no verdict comes before it.

A new head needs a new green light unless a carry rule holds.

**A contract or direction question before a build** goes to the same maintainer, by
message: the question and the proposed contract or spec at its exact revision. It needs
no PR and no CI.

## 3. Merge
When every agreement holds at the same head and no hold is open on the PR or the default
branch, whoever your landing rules name merges:
- **You:** merge at that head, guarded by it (the forge's merge-at-head option), and say
  so in one line in the effort's thread. As a specialist, tell your parent.
- **The developer:** give it the go in one line, at that head, once you have checked
  every agreement and the holds. It checks the holds again, merges and tells you.
- **The lane's maintainer:** hand it the PR at that head. The merge is its step.
- **A person:** the root lead hands them the PR at that head in the effort's thread, with
  the agreements cited, and sets needs-input. It is a hand-off, not a card: the decision
  was taken when the agreements were met.

Then check CI on the merged commit, and fix forward if it breaks. Tell the developer the
merge commit: it sends its done line and retires itself. Update the record's status.

**A merged PR is not a shipped one.** Say "shipped" or "released" only after you have
checked the release, the deploy or the pin that carries it, as the organisation ships.

## 4. A conflict with the default branch
The first merge wins. The author updates the branch as `/work-the-reviews` says, proves
it again and pushes. Verify a developer's delta again, and check the agreements at the
new head. Decisions people already took hold: nobody is asked to decide again.

## 5. A release
Where your landing rules give releases to a maintainer, hand the release lane's
maintainer what goes in and the head to tag. The release is its step, and it tells you
once it is out. Where they give a release to you, send its owner one card listing what
goes in and the head to tag (`/hand-off-and-ask`); after their yes, tag and publish as
your release procedure says, and tell them in one line that it is out.

## 6. When it has landed
Act on what the merge unblocks. Each finished child retires itself: check that none is
still listed. When your own seat is finished, as `/wait-and-retire` defines it, retire
yourself.
