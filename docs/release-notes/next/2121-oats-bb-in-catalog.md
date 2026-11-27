## Provider updates

- **`oats.bb` v0.8.0 joins the official catalog,** and this repository's
  workspace pins it, with `oats.bb: { from: package }` in its default
  capabilities so every soul can be spawned on bb. It is the bb session
  provider: an instance runs as one bb thread
  ([Execution targets](../execution-targets.md)). It needs OATS 0.70.5 or
  later. From this release, a bare `oats.bb: v0.8.0` pin resolves through
  the catalog; on an older CLI, pin it by Git reference
  (`git:github.com/oats-project/oats-bb@v0.8.0`).
  The provider is the one first pinned here, unchanged apart from its
  version. What moved since is its bb plugin, which is installed in bb at
  the same tag (the package's `plugin/README.md`, "Install"): a Terminal
  for an agent on tmux and a read-only Mail tab (0.6.0); the Workspace
  page, shown by default, and New agent on a deployment with no bb session
  provider (0.7.0); the Board, where an agent's questions are answered
  from bb, and four tabs in every agent's panel (0.8.0). In bb, a press on
  an option of a question sends the answer at once. The package's
  CHANGELOG has each release's upgrade notes.
