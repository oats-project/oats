---
name: pr-review
description: Read a PR at the exact head an author names, when your lane's landing rules need your read or reserve the merge for you - four gates (direction, correctness, security, mergeability), the verdict bound to that head on the PR and told to the author in one line, and, where the merge is yours, merging only that head after checking holds and a moved default branch, then checking that what landed is what was read. Covers outside contributors' PRs, the release lane's reads, moving heads, bringing a branch up to date without a new read, and holds. Use before every verdict and every merge reserved for you, when verifying fixes, and when reconciling a stale verdict or a HOLD/GO instruction.
---

# Review the exact change

## Which PRs, and when
- **When an author calls you,** by message at an exact head, for the read or the merge your
  lane's landing rules need from you (`/cross-review-peer`, "A lane's arrangement"). You are
  never a station every PR passes: a PR nobody calls you for lands on its lane's other
  agreements, and you read it only if your sweep finds a reason to (`/keep-it-clean`).
- **The call names:** the exact head, CI green on it, the lead's verification note at that
  head, and the reviews the lane counts, where they are in. Before CI is green at that head,
  no read: tell the author what is missing, in one line.
- **A head that moves after the call:** stop until the author calls again, then read only
  the delta and re-bind your verdict. A branch you brought up to date yourself is not a new
  head to read (Merge).
- **No owning expert** (an outside contributor's PR, a person's own): ready when its author
  marks it ready (not a draft) or asks for a read at a named head, with CI green. For a
  fork, the workflow and secrets check (Security) comes first, so CI can run.
- **A PR a maintainer authored itself** (release prep only: the version bump and the notes;
  a fix goes to a lead and its developer, `/launch-work`): it lands as your landing rules
  say for a PR with no lead. You never approve your own.
- **As an overflow seat,** the calls for the efforts your parent gave you: give the verdict
  at the head, and refer a merge reserved for the lane to your parent (`/cross-review-peer`,
  "An overflow seat").

Pin the base and head SHAs before you read a line. Read
[references/reviewed-delivery.md](references/reviewed-delivery.md) when the head moved, a
hold applies, or you are about to merge.

Read the author's evidence, given at this head: what it was verified with and, where the
project uses them, the pre-PR review's verdict and rounds and the lead's verification note.
Missing: ask the author for it at this head. These inform your read and don't replace it.

Read the PR as a whole: the description's claim against the diff, the scope against what
was asked, and the work item, spec and dependent PRs linked.

## Four gates
1. **Direction** (`/direction-gate`), against the full diff.
2. **Correctness.** Read the whole diff, from an exact-commit checkout of your own, never
   another agent's work tree. Find the consumers of every changed export, signature, output
   or message shape, config key, flag, error code and file format, here and in the
   repositories that depend on it, and read how each uses it, even when your project's
   review notes list them. A behaviour change updates its tests in the same change; an
   assertion is never weakened to make it pass.
3. **Security.** Data becoming execution (commands, paths, queries, templates), trust and
   integrity checks, path containment, identity and authorisation, secrets, rendering of
   user content. Also:
   - **Forks and first-time contributors:** CI that would run their code with secrets or
     write permissions, and any change to CI workflows, permissions or secrets handling, is
     reviewed before CI runs it.
   - **Dependencies:** each new or bumped one is a supply-chain change: check that it's
     needed, where it comes from, that it's pinned, and that its lockfile change matches the
     manifest change and nothing else.
4. **Mergeability.** The head, base and checks are the ones you reviewed; no conflicts (the
   author resolves them); no unresolved threads, other reviewers' and bots' comments
   answered; not a draft; docs and release notes cover it (`/keep-it-clean`); it's in the
   next release's plan (`/plan-release`). A PR too large to review well is split first.

Don't ask for a full local run. When you reproduce a finding locally, say what you ran.

## Verdict
Bound to the reviewed SHA and posted on the PR, not only in a message: as a review, or as
a comment with the verdict and SHA where the forge refuses the approval (own PR, a shared
account):
- **APPROVE** at `<sha>`;
- **RETURN** with prioritised findings, each with file, line and how to reproduce;
- **ESCALATE** a direction question, to whoever decides it.

Only correctness, safety, direction and coherence-rule findings block; approve over the
rest and record them as follow-ups (`/keep-it-clean`). Tell the author the verdict in one
line, in its thread.

## Your verdict is one agreement
Your verdict is one of the agreements the lane's landing rules name. The author gathers the
others (CI, the reviews, its verification note, another lane's read where its code is
touched) and merges, unless the lane reserves the merge for you. A PR with no lead (an
outside contributor's) is yours to merge where your landing rules say so: at its head, once
every agreement they name for it holds. You forward nothing to
another maintainer and ask no one else for a read: where a PR also needs another lane's
read, its author asks that lane's maintainer.

**As the release lane's maintainer,** read what the landing rules give you the same way,
with all four gates. Your APPROVE on the PR at that head is the release lane's agreement.
A RETURN goes to the author, which calls you again at the fixed head.

## Merge
This section is yours when the lane's landing rules reserve the merge for you; a lead
merging its own PR follows its own landing skill.
- **Who:** you, where the landing rules reserve the merge for your lane, on the author's
  call at the head to merge. A maintainer alone merges what its landing rules give it.
- **Needs:** the authority; every agreement the landing rules name, at the current head
  (CI green, the reviews, the lead's verification note, your verdict, and any other lane's
  read the PR needs). An earlier-head verdict carries only as Merge says below.
- **No hold:** no hold recorded on the PR, and every open default-branch hold names an
  exception for this PR at this head (`/cross-review-peer`, "Holds").
- **The default branch moved since CI ran on this head?** Two changes that share no file
  can still break each other (one changes a text, the other's test reads it). So:
  1. on a trial merge onto the default branch, run the test files changed or added by this
     PR and by what merged since its base;
  2. if those are more than a couple, need what your host lacks, or are code you haven't
     read and trusted (an outside contributor's), bring the branch up to date and let CI
     be the run.

  With a merge queue, enqueue the approved head: it does this and the next two checks.
- **Bringing a branch up to date is yours,** with the forge's update of the PR branch (a
  merge of the default branch into it, never a force-push, no work tree touched). The
  verdicts carry when the PR's own change (`git diff <default-branch>...<updated-head>`)
  matches the reviewed diff (`git diff <base-at-review>...<reviewed-sha>`; context may
  differ) and CI is green. Post the comparison on the PR from your own run; message
  nobody. A conflict goes back to the author. A check CI doesn't make (another OS, a live
  run) carries over only when you say so on the PR, with why the new changes can't touch it.
- **A head its author rebased:** the verdicts carry when every commit is `=` in
  `git range-diff <base-at-review>..<reviewed-sha> <new-base>..<new-head>` and CI is green.
  Post the range-diff on the PR from your own run. Any commit not `=` goes back to you, and
  to the PR's other readers, for that delta.
- Merge with the repository's strategy, guarded by the head: the forge's merge that refuses
  unless the PR's head is still `<merge-head>`, the reviewed head or the head the verdicts
  carried to. Keep
  `<base-at-review>` and `<reviewed-sha>` as the record. The guard covers the head, not the
  base. Check that a merge queue or auto-merge merges that head.
- **Check that what landed is what you reviewed:** fetch, find the merge commit (the forge
  records it on the PR), then:
  - squash or merge commit, branch up to date: the trees are equal
    (`git diff --quiet <merge-head> <merge-commit>`);
  - squash or merge commit, base moved: `git diff <merge-commit>^ <merge-commit>` matches
    the reviewed diff, context aside;
  - rebase merge: `git range-diff <base-at-review>..<reviewed-sha> <new-base>..<tip>`.
- Watch CI on the merged commit, and get a break fixed forward.
- Tell the author it's in, in one line with the merge commit, when the author is an agent.
  A human author is told only when they must act on it: the forge shows the merge. No other
  merge notice to peers.
- A failed client response can follow a completed merge: observe the remote state before
  retrying or reporting.
