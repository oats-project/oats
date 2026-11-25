## Provider updates

- **`oats.bb` v0.4.0 joins the official catalog,** and this repository's
  workspace pins it, with `oats.bb: { from: package }` in its default
  capabilities so every soul can be spawned on bb. It is the bb session
  provider: an instance runs as one bb thread
  ([Execution targets](../execution-targets.md)). It needs OATS 0.70.5 or
  later. From this release, a bare `oats.bb: v0.4.0` pin resolves through
  the catalog; on an older CLI, pin it by Git reference
  (`git:github.com/oats-project/oats-bb@v0.4.0`).
