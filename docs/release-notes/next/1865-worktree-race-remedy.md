## Fixed

- **`oats worktree add`'s `E_BRANCH_EXISTS` carries its remedy when it loses
  a race too.** When another `add` or another git makes the branch between
  the check before the tree is made and this add's `git switch -c`, the
  refusal's `details` now carry `clone` and `remedy` (`<instance>/<branch>`)
  beside `branch`, and its message names the remedy, as the earlier check's
  always did. Both are built in one place, so they stay the same. The change
  is additive. The [errors of `oats worktree add`](../desktop-cli-api.md#oats-worktree)
  now also say that a racing `add` can end in either code: a switch that
  meets the branch's ref lock while another git holds it answers
  `E_GIT_FAILED` with Git's message, because a lock left by a git that
  crashed looks the same and the branch does not exist yet. A caller that
  retries once the branch exists gets `E_BRANCH_EXISTS`, with its remedy
  (oats-project/oats#1865).
