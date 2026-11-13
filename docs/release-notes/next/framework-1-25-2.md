## Changed

- **`oats.framework` 1.25.2: `oats.core` 2.13.2.** `oats.core`'s
  `/oats-operate` says that a `directory`-mode instance can make extra trees
  too: work that needs a branch goes in an extra tree of its own, made with
  `oats worktree add --repo <repo>`, and its `./work` never becomes a
  repository.

  No capability needs a newer OATS: `oats worktree add --repo` has worked
  from a directory-mode home since OATS 0.49.0.
