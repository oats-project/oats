---
name: land-on-agreement
description: Take your effort's PRs to merge - for a developer's work, your verification note and the lane's green light, the developer opening the PR and working its reviews (it, never you, iterates with fresh reviewers); for a change you built, the clean round of your own review loop and you opening and working the PR; the maintainer's read where the lane needs one, the merge at that exact head by whoever your landing rules name once every agreement holds, rebases without re-asking anyone, a release its owner approved - and retire what's finished, yourself last. Use whenever your work becomes a PR, while it is open, for a release you lead, and when an instance you started, or your effort, is finished.
---

IMPORTANT: after a compaction, reload this skill before you continue the step.

# Land on agreement

## Your landing rules
Your landing rules are in your briefing, with any change to them you recorded since (the
rules say how), which wins. Per lane, they name the agreements that merge a change, who
merges, who gives the green light to open a PR, what a one-line docs fix needs, where a
maintainer's read is required (on a PR, or on a contract change before it is built), and
the one-way doors kept for people. Read them once per effort, and again after a
compaction. None in your briefing: that is a block (`/findings-and-blocks`); merge nothing
until it is settled.

## 1. Verify, or your own clean round
**A developer's work,** or a helper's scoped piece: its author iterates with fresh
reviewers, not you. Its branch comes back at the head of a round that found nothing to
fix: verify it once (`/verify-developer-work`), ending with `VERIFIED at <head>` and the
checks you ran. What you find goes back to its author, which fixes it and runs its loop
again. You never run review rounds or spawn reviewers for it.

**A change you built:** you ran its review loop (`/run-the-review-loop`), each round's
reviewer a fresh `code-reviewer` instance, your child, never you. The round that found
nothing to fix, with its Checked section, is the green light: nobody verifies their own
work, so there is no `VERIFIED` note. Open the PR at that head and work its reviews
(`/work-the-reviews`), then go on from section 4.

**A one-line docs fix** (a typo, a broken link) skips the local loop, not the review. Prove
it the way the repository checks its docs, open its PR, and land it on CI green and one
fresh review at its head: the review bot's where one runs, otherwise one reviewer round
(`/run-the-review-loop`). If that review finds anything to fix, it is no longer a one-line
fix: it gets the loop.

## 2. The green light, and the PR
For a developer's work, or a helper's scoped piece (a change you built: section 1):
- Where the lane names another authority for the green light, ask it first (`/hand-off`)
  at the verified head. Then give the developer the green light in one message: `VERIFIED
  at <head>`, open the PR, and the reviews the lane counts (the forge's review bot, or its
  own review loop). It opens the PR and works its reviews; it raises to you only what
  needs product or architecture direction. Answer that by message.
- Once the PR exists, post your note on it: `VERIFIED at <head>: <the checks you ran>`.

## 3. Handed back ready
When the developer hands the PR back ready, read what changed since your verified head.
Verify again only if the change touches the design (the architecture, a contract, a
recorded decision); what you find goes back to the developer, as in section 1. Otherwise
post `VERIFIED at <new head>: delta since <old head> read, no design change`.

A decline with a concrete reason answers its finding: read the ones the developer lists,
and return one to it only where it touches the design or a contract, which goes to whoever
decides it.

## 4. The maintainer's read
Where the lane requires one: the maintainer of the person who owns that lane
(`/find-the-maintainer`). Hand it the PR at its head (`/hand-off`) and wait for its verdict
by message. A new head goes back to it for the delta.
<!-- OATS: the lane map gives every PR a maintainer and one second reader, and most lanes the release lane's sign-off. -->
Here every lane requires one: the PR's maintainer, the one of your person in its lane. It
asks the PR's second reader and the release lane's sign-off as the lane's line says; you
don't. A RETURN from any of them goes to the change's author: to your developer or helper,
like a finding of yours, for their work; for a change you built, you fix it or dispute it
yourself, and its new head is reviewed as `/work-the-reviews` says.

## 5. Merge
When every agreement holds at the same head (CI, the reviews the lane counts, your note on
a developer's work, the maintainer's verdict where needed) and nothing holds the PR or the
default branch (your landing rules say how holds are recorded), the one your landing rules
name merges it:
<!-- OATS: the lane map's agreements: the second reader's verdict, the release lane's sign-off where the lane asks, and no RETURN. -->
(here the agreements include the second reader's verdict and, where the lane asks, the
release lane's sign-off, all at that head, with no RETURN outstanding)
- **you:** merge at that head, guarded by it (the forge's merge-at-head option), and say so
  in one line in the effort's thread;
- **the developer:** give it the go in one line, at that head, once you have checked every
  agreement and the holds; it checks the holds again, merges and tells you;
- **the lane's maintainer:** hand it the PR at that head (`/hand-off`); the merge is its
  step;
- **a person:** hand them the PR at that head in the effort's thread (`/hand-off`), set
  needs-input, and wait. It is a hand-off, not a card: the decision was taken when the
  agreements were met.

Then check CI on the merged commit, and fix forward if it breaks.

## 6. A conflict with the default branch
The first merge wins. The author (the developer, or you for a change you built) rebases,
proves it again, and runs a fresh review round where the lane counts its review loop and the
rebase changed a commit. Verify a developer's delta again, and check the agreements again
at the new head. Decisions people already took hold
through the rebase: nobody is asked to decide again.

## 7. After the merge
Tell the developer it is merged, with the merge commit; it finishes and sends its done
line. Update the record's status, and act on what the merge unblocks.

## 8. A release
Where your landing rules give a release to a maintainer, hand the release lane's maintainer
(`/find-the-maintainer`) what goes in and the head to tag; the release is its step, and it
tells you once it is out. Where they give it to you: send its owner one card
(`/ask-a-person`) listing what goes in and the head to tag. After their yes, tag and publish
as your release procedure says, and tell them in one line that it is out.

## Retire what's finished
Finished instances are retired without asking or telling a person. Spawning and retiring
never involve one: done lines go to the parent that retires the child.

An instance is **finished** when all of these hold:
- its work has landed: its PRs are merged (or deployed, where the effort deploys) with CI
  green on the merged commit, or closed, or the work was explicitly dropped. Handed back
  is not landed: it may still be needed for fixes and rebases. A probe's work is its
  answer;
- nothing waits on it: no open PR, review, question, finding without an owner or hand-back
  of its own, and its own children are retired;
- with a harvest duty (your knowledge layer says whether you have one), its final harvest
  checkpoint ("you finish a task") is recorded in its log.md with the harvester's name, and
  the harvester is launched. The harvester snapshots its evidence at spawn and the retire
  keeps a recovery copy, so nobody waits for the harvester to finish.

- **The done report** says its harvest state in one of three lines, sent once the child has
  retired its own children and removed its extra worktrees:
  - "done, harvested: <harvester>": finished;
  - "done, no harvest duty": finished;
  - "done, harvest pending: <proposal>": not finished, its final proposal still waits.
    Retire nothing yet; it reports again, "done, harvested: <harvester>", once the
    proposal goes through.

  Ask for the line when a done report lacks it. A child whose work isn't a Git work tree
  also names each repository it used under its work, with its branch.
- **Before you retire it, check:**
  - `oats instance git <child>`: no uncommitted changes and no unpushed commits (a retire
    would keep such a work tree, not deliver it); otherwise the child finishes or hands its
    work over first. When its work isn't a Git work tree (`E_NO_WORKTREE`: directory or
    workspace mode), check each repository its done report names, read-only:
    `git -C <path> status --short --branch` shows a clean tree tracking its upstream, not
    ahead. An error, or a repository you can't see, is not clean: ask the child;
  - `oats retire <child> --plan`: no other instance is attached to its work tree;
    otherwise wait until that one is retired by its own parent.
- **Retire it** with `oats retire <child>`, and record it in your state (name, why). No
  acknowledgement is needed.
- **Only your own children.** Never retire another's child: tell its parent instead.
  Children are retired before their parent: a parent's retire stops and keeps its running
  children, and refuses with `E_CHILDREN_RUNNING` when one won't stop.
- **Never reuse a name:** a new instance never takes a retired one's name, which couldn't
  harvest.
- **Your developers:** once the PR is merged and green, or closed, and it sends its done
  line.
- **Your helpers:** a helper with a scoped piece of work once that work has landed, as a
  developer is. **Your probes** (helpers with a question): once they have answered
  (`/send-a-helper`). A probe's work is its answer,
  and its scratch commits are not delivered: skip the `oats instance git` check, and where
  it has a work tree, retire it with `oats retire <probe> --discard-worktree`. Retire any
  probe that hasn't answered too.
- **Yourself:** once your effort is finished (its PRs merged and green or closed, each
  finding with an owner, nothing waiting on you), retire your children, close the effort's
  record, run your final checkpoint, and send your person one done note in the effort's
  thread. Then, with an OATS parent, send it your done line, unprompted; it retires you.
  With none (spawned `--relation unrelated`, or started directly by a person), run the same
  checks on yourself and retire yourself with `oats retire "$OATS_INSTANCE" --self` (the
  instance name is required).
