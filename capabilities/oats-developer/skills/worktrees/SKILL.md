---
name: worktrees
description: When and how to use extra worktrees (workflow paths that touch the same files, a spike, another branch or base), consolidate them before review, remove the path trees before handing back and the consolidated one at finish. Use when your execution strategy needs more than one checkout.
---

# Extra worktrees

Your work-mode briefing gives the command. Create as many as the work needs, each on a new
branch (the kernel never reuses or resets one); by default they live in your home as
`.work-<purpose>`. To rework an existing branch, an open PR's say, start the new branch from
it as the remote base and push its `HEAD` back to that branch.

## When
- Workflow paths that touch the same files: one worktree per path. Paths on different
  files share one.
- A spike you may throw away, kept apart from the real branch.
- Another branch: a fix on another base, a stacked change, an open PR you're asked to
  rework.

## Use
Base each worktree on the branch it will merge back into; each path builds and tests in
its own.

## Consolidate before review
Before the first review round, bring everything into one worktree, the one whose branch
becomes the PR:
1. Merge each path in, in the planned order, resolving conflicts yourself.
2. Run the full verification there.
3. Run each round's reviewer on it; the other worktrees are no longer part of the work.
   It stays until you finish: every round, your expert's return and your PR's fixes run
   on it, so retiring a round's reviewer never removes it.

## Before handing back
- Every other worktree is merged, or its branch is pushed and named in your handback, or
  it was deliberately abandoned.
- Remove every other extra worktree you created that no instance is attached to. The
  consolidated one stays, even when it is an extra tree.
- Retire the instances attached to a worktree before you remove it. One with an instance
  attached (usually a round's reviewer) stays until that instance is retired (Close of
  `/run-the-review-loop`).

## At Finish
Before you report done (Finish of `/run-the-review-loop`), with your PR merged or closed:
retire whatever is still attached, then remove every extra worktree you made, the
consolidated one and any a later fix made included: a retire keeps a worktree that holds
work. The worktree list then shows only your main tree.
