## Changed

- **`oats.framework` 1.25.1: `oats.core` 2.13.1.** `oats.core`'s
  `/oats-operate` says that a `workspace`-mode instance can also make extra
  trees: work that needs a branch of a member goes in an extra tree of its
  own, made with `oats worktree add --repo <member>`. The member clones stay
  read-only.

  No capability needs a newer OATS: `oats worktree add --repo` has worked
  from a workspace-mode home since OATS 0.49.0.
