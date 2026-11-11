## Fixed

- **A checkout OATS makes runs no filter driver the repository's
  configuration defines.** The `git worktree add` of a spawn into a worktree,
  and the `git worktree add` and `git switch` of `oats worktree add`, ran the
  `filter.<name>.smudge` or `.process` command the clone's configuration
  names for a file carrying the `filter` attribute, as whoever spawned. Each
  is preceded by one read of that configuration, and every driver it defines
  is overridden to no command, as for a retire's status: such a file is
  written as its committed bytes
  ([a checkout runs no filter driver](../souls-and-instances.md#checkout-filter-drivers)).
  - A driver the operator's global or system configuration defines runs as
    before: Git LFS set up with `git lfs install` checks its files out. With
    `git lfs install --local` alone, a tree OATS checks out holds the
    pointer files: run `git lfs install`, or `git lfs pull` in the tree.
  - A driver whose name cannot be passed on Git's command line (it holds `=`
    or is not UTF-8) refuses the checkout. The spawn's refusal is
    `E_WORK_INSPECTION_FAILED`, as before, raised before
    `git worktree add` and no longer at the baseline's status, with the
    message `could not make the instance worktree: git worktree add was not
    run in <clone>: …`; `oats worktree add` answers `E_GIT_FAILED`.
- **No Git command OATS runs on a work tree's files or index runs the file
  monitor the repository's configuration names.** The same three commands,
  the fetch of `oats worktree add`, the reads of `oats worktree remove` (its
  status, the clean check inside `git worktree remove`, the comparison of an
  unregistered tree's surviving files) and the check `oats package
  add|remove` makes that `oats-workspace.yaml` is tracked ran the
  `core.fsmonitor` command of the repository's configuration when they read
  the index of the tree. They run with `core.fsmonitor=false`, as a retire
  and `oats instance git` do
  ([no file monitor](../souls-and-instances.md#no-file-monitor)). The clone's Git
  hooks (`post-checkout` among them) still run at these checkouts.
- **A driver of the operator's that has no `process` command runs where the
  repository's configuration names the same driver.** This reaches every
  command that takes these overrides: a retire and `oats worktree remove` as
  well as a checkout. Each overrides that driver with the operator's values.
  They also set its `process` to nothing, which made Git skip the operator's
  `clean` and `smudge` commands. `process` is left alone when neither
  configuration defines it. When the repository defines it and the operator
  does not, neither side's command runs.
