## Changed

- **The `workspace` work mode teaches extra trees.** Its briefing no longer
  lists worktrees among the Git operations it forbids, which contradicted the
  instance-boundary block ("repository work happens there, or in the extra
  trees your mode block grants"). Member clones stay read-only through
  `./work`; work that needs a member's branch goes in an extra tree of the
  instance's own, made with
  `oats worktree add --purpose <p> --branch <b> --base <remote-branch> --repo <member>`,
  which moves none of the clone's refs. `--repo` is always named in this mode:
  the home's recorded repository is the deployment directory, so `add` without
  it is refused (`E_CLONE_MISSING`). A workspace instance's `TASK.md` says the
  same. What work an instance takes on stays its role's and its task's call
  ([work modes](../souls-and-instances.md#workspace--cross-repo-coordinator)).
  Existing homes keep the briefing they were composed with; a new spawn picks
  this one up.
