## Upgrade

- **`oats sync` and `oats sync --plan` now refuse a package whose
  `oats-package.json` names another package than the `packages:` key it is
  pinned under** (oats-project/oats#1759). The refusal is
  `E_PACKAGE_INTEGRITY` with `why: "package-id"`. Its message names both ids
  and the line to write in place of the key, then `oats sync`. A refused sync
  writes nothing, and a lock that already holds such an entry is refused at
  the next sync. Existing homes, and spawns from the current lock, keep
  working until the line is fixed. Every version in the official catalog
  names its own id. Before upgrading, check each `git:` pin in `packages:` on
  the version you are leaving: the repository's `oats-package.json` at that
  ref must say `"package": "<the key>"`
  ([`oats sync`](../packages.md#oats-sync--the-one-command-for-the-common-path)).

## Fixed

- **A package pinned under another package's id is no longer locked
  silently** (oats-project/oats#1759). `oats.engineering: v2.0.0`, whose
  manifest names `oats.engineering-coordination`, was locked under
  `oats.engineering`, and its souls were named `oats.engineering/<soul>`.
  `sync` now refuses it, and names the line to write under
  `oats.engineering-coordination`: that id at the same version when the
  catalog lists it, else
  `git:https://github.com/awebai/oats-engineering.git@v2.0.0`.
