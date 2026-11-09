## Changed

- **A `souls:` pattern that matches no soul now warns `team-soul-unknown`**
  (oats-project/oats#1759). A `<prefix>/*` key in `oats-workspace.yaml`
  `souls:` whose prefix is no member or package with souls here (a typo, or a
  package that was renamed or dropped) was ignored without a word; exact keys
  already got the warning.
  - It shows where an exact key's warning shows: `oats teams` and readiness
    (`checks.configured`, not required), with the same code, `severity`,
    `key` and `at`. Its message says the pattern matches no soul.
  - The fix: correct the prefix to a member's or package's name (`oats souls`
    lists them), or remove the key. A pattern that matches at least one soul,
    and `"*"`, stay silent. Exact keys' message and fix are unchanged
  ([Workspaces](../workspaces.md), [Team readiness items](../desktop-cli-api.md#team-readiness-items)).

## Documentation

- **The official catalog page says how `from: package` finds its package**
  (oats-project/oats#1759). It said a capability id selects its package
  through the catalog's aliases. It resolves through the workspace's lock, to
  the one locked package that lists the capability; two such packages are
  refused with `E_PACKAGE_MISSING`. The catalog's `capabilities` map is read
  only to pick a standalone deployment's package
  ([Official catalog](../official-catalog.md)).
