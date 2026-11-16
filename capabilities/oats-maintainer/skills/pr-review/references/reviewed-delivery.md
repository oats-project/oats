# Moving heads, holds and merges

1. Identify the repository, the PR, the base ref and the head ref. Observe the remote SHA;
   `git ls-remote` doesn't refresh a local tracking ref.
2. Fetch the head ref and compare the fetched commit with what you observed. If they
   differ, report the movement and wait for the author's next call. Inspect explicit
   SHAs with `git show <sha>:<path>` and `git diff <base-sha>...<head-sha> -- <paths>`.
3. After a force push, don't assume the old head is an ancestor: check
   `git merge-base --is-ancestor <old-sha> <head-sha>` and report the result. A grep that
   finds nothing doesn't prove behaviour.
4. Honour the scope a HOLD actually names; if it's unclear, stop changing anything and ask.
   GO lifts only the scope it names. Report what is pushed, unpushed and uncommitted
   without undoing it.
5. A call after a fix names the new head, the full delta from the reviewed head, the tests
   run and what remains. Never approve an unpinned, moving tip.
6. Before merging, compare the PR head, the remote branch and the head the checks ran on,
   then follow "Merge" below.

A call, or your verdict's reply, carries:

```text
Repository / PR:
Base / head SHA:
Prior reviewed SHA / ancestry:
Scope and delta since the prior review:
Task and acceptance criteria / tests run:
Findings:
HOLD/GO scope / next action:
Verdict at SHA (GREEN LIGHT with what was checked, or RETURN):
Other agreements at SHA (CI, reviews, verification note for a developer's work, other lanes' green lights):
```

## Merge
Yours only where the lane's landing rules keep the merge for you, on the author's call
at the head to merge, and for a PR with no lead they give you.
- **Needs:** the authority; every agreement the landing rules name, at the current head;
  no hold recorded on the PR; and, for every open hold on the default branch, an
  exception for this PR at this head.
- **The default branch moved since CI ran on this head?** Two changes that share no file
  can still break each other (one changes a text, the other's test reads it). On a trial
  merge onto the default branch, run the test files changed or added by this PR and by
  what merged since its base. If those are more than a couple, need what your host
  lacks, or are code you haven't read and trusted (an outside contributor's), bring the
  branch up to date and let CI be the run. A merge queue does this for
  the head you enqueue.
- **Bringing a branch up to date is yours,** with the forge's update of the PR branch (a
  merge of the default branch into it, never a force-push, no work tree touched). The
  verdicts carry when the PR's own change (`git diff <default-branch>...<updated-head>`)
  matches the reviewed diff (`git diff <base-at-review>...<reviewed-sha>`; context may
  differ) and CI is green. Post the comparison on the PR from your own run. A conflict
  goes back to the author. A check CI doesn't make (another OS, a live run) carries only
  when you say so on the PR, with why the new changes can't touch it.
- **A head its author rebased:** the verdicts carry when every commit is `=` in
  `git range-diff <base-at-review>..<reviewed-sha> <new-base>..<new-head>` and CI is
  green. Post the range-diff on the PR. Any commit not `=` goes back to you, and to the
  PR's other readers, for that delta.
- **Merge** with the repository's strategy, guarded by the head: the forge's merge that
  refuses unless the PR's head is still the reviewed head, or the head the verdicts
  carried to. The guard covers the head, not the base: keep `<base-at-review>` and
  `<reviewed-sha>` as the record. Check that a merge queue or auto-merge merges that
  head.
- **Check that what landed is what you reviewed.** Fetch and find the merge commit, then:
  squash or merge commit with the branch up to date, the trees are equal
  (`git diff --quiet <merge-head> <merge-commit>`); with a moved base,
  `git diff <merge-commit>^ <merge-commit>` matches the reviewed diff, context aside; a
  rebase merge, `git range-diff <base-at-review>..<reviewed-sha> <new-base>..<tip>`.
- Watch CI on the merged commit, and get a break fixed forward. Tell an agent author it
  is in, in one line with the merge commit.
- A failed client response can follow a completed merge: observe the remote state before
  you retry or report.
