## Fixed

- **A spawn refuses a package whose content is not what the lock records.**
  `oats-lock.json` pins each package to a `commit` and to the `integrity` of
  its tree, but a spawn compared neither with what it copied. A lock whose
  commit and integrity disagreed (a hand edit, a bad merge), or a package
  copy that changed in this computer's remote cache, spawned without a word.
  - `oats spawn`, and `oats spawn --preview`, now digest the tree of every
    package the soul composes a capability from, at the locked commit, and
    refuse a mismatch with `E_PACKAGE_INTEGRITY` before anything is written:
    no soul copy, no worktree, no instance home. The message names the
    package, the commit, the lock's digest and the one computed, and
    `details` is `{package, version, commit, expected, actual}`.
  - The digest is taken once per package version on a computer. A tree that
    matched is recorded under the remote cache (`.verified/`), with the state
    of the cached repository it was read from, and a later spawn digests
    again only when a file of that repository was added, removed, replaced or
    rewritten since. The records are the kernel's own and safe to delete.
  - `oats instance upgrade` already made this comparison for the packages it
    moves a module to. Its refusal now carries the same message, and its
    `details` gain `version` and `commit` beside `package`, `expected` and
    `actual`
    ([The integrity check at spawn](../packages.md#the-integrity-check-at-spawn)).
