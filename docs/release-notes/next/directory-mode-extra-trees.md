## Changed

- **The `directory` work mode teaches extra trees.** Its briefing granted
  none, while the instance-boundary block says repository work happens "there,
  or in the extra trees your mode block grants", and `oats worktree add`
  already worked from a directory home. `./work` stays an owned directory
  that never becomes a repository; repository work that needs a branch goes in
  an extra tree of the instance's own, with the same "Extra trees" section as
  the `workspace` briefing:
  `oats worktree add --purpose <p> --branch <b> --base <remote-branch> --repo <repo>`.
  `--repo` is always named: the home's recorded repository is configuration
  context, the deployment directory by default, so `add` without it is
  refused there (`E_CLONE_MISSING`). A directory instance's `TASK.md` says the
  same ("Work in ./work; do repository work only in your extra trees.")
  ([work modes](../souls-and-instances.md#directory--independent-execution)).
  Existing homes keep the briefing they were composed with; a new spawn picks
  this one up.
