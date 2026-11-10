## Upgrade

- **`@awebai/oats` declares the Node it needs: 22.5.0 or later.** Check
  `node --version` on each host before upgrading. On an older Node, `npm
  install -g @awebai/oats` now warns `EBADENGINE` (and refuses where npm's
  `engine-strict` is set): install Node 22, whose current releases are all
  past 22.5, then install OATS. Hosts on Node 22.5 or later change nothing.

## Changed

- **The kernel's package declares `engines.node: >=22.5.0`.** It declared no
  floor, while CI runs Node 22 and the turn record the kernel ships reads its
  index through `node:sqlite`, which Node has from 22.5. The floor is the one
  `@awebai/turn-record` already declared. `npm run validate` holds the root
  package to a declared floor, the lock to the same one, and every package
  under `packages/` to no lower one.
  [First team](../first-team.md#0-prerequisites) states the floor.
