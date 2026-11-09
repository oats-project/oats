## Added

- **A renamed official package's old and new id name one package.** The
  kernel holds a table of renamed packages, the way it holds one of moved
  repositories. Its one entry is `oats.engineering` →
  `oats.engineering-coordination`. The kernel compares through it and never
  rewrites: `instance.json`, the lock, `oats-local.yaml`,
  `oats-workspace.yaml`, schedules and triggers keep the id they name, and a
  home's `OATS_SOUL_ID` stays `package:oats.engineering#<soul>`
  ([Renamed packages](../workspaces.md#renamed-packages)).
  - A soul named `oats.engineering/<soul>` reaches
    `oats.engineering-coordination/<soul>` in `oats spawn` and its preview,
    `oats soul teams`, `oats soul launch`, `oats capabilities show --package`,
    schedules and triggers. Spawn (preview and apply), `oats soul teams` and
    `oats soul launch` also print one `note:` line saying so, and their
    `--json` answer carries it in `notes`. A new spawn records the new id.
  - A `souls.launch` key or `souls.disabled` entry in `oats-local.yaml`, and
    a `souls:` key or `<package>/*` pattern in `oats-workspace.yaml`, spelled
    with the old id apply to the renamed package's souls. Neither is reported
    as naming no soul.
  - A home recorded under the old id reads the new id's lock entry: its
    modules and soul are `moved`, not missing, and readiness passes. `oats
    instance upgrade --plan` keeps such a module and names the respawn that
    moves the home onto the new package.
  - The migration is a pin swap: `oats.engineering: v1.18.0` becomes
    `oats.engineering-coordination: v2.x`, then `oats sync`. Old homes keep
    working; respawn them to move them.

## Changed

- **`oats sync` refuses a renamed package declared under both its ids.**
  `packages:` naming `oats.engineering` and `oats.engineering-coordination` is
  `E_WORKSPACE_SCHEMA`, details `{path, reason: "package-declared-twice", ids,
  keep}`, and the message names the id to keep
  ([Renamed packages](../workspaces.md#renamed-packages)).

## Fixed

- **Readiness no longer tells a home to declare a package that is gone.** For
  every package: when a home's package soul's package is no longer locked, the
  remedy names the package's new id when it was renamed, and otherwise says to
  spawn a new instance from a soul the workspace offers and retire this one.
- **A start or restart names the respawn for package modules an upgrade
  cannot move.** For every package: modules whose package or capability is gone
  from the lock, or whose package was renamed, add one string to `warnings`
  that names each and says to respawn the instance. `drift` still lists only
  the modules an upgrade moves in place
  ([Start and restart](../desktop-cli-api.md#start-and-restart)).
