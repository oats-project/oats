## Changed

- **The credential receiver checks shared destinations from both sides, and
  acceptance keeps a credentials source apart from every shared mount**
  (#2149, #2150).
  - Harness mode (no `--credential`) now refuses a `teams` destination whose
    file or directory is a personal credential's, by any spelling or through
    any symlink that exists, with `configured path is shared with another
    entry`, for `install`, `status` and `remove`. Only an already-wrong
    configuration is refused, and an alias made after an install is refused
    too.
  - Acceptance refuses a `TEAM_CREDENTIALS_DIR` that overlaps `/mirrors` or
    the trust CA as well, with `credentials must stay outside agent-writable
    sources, /inputs, /outbox, /mirrors and the trust CA`.
  - [servers.md](../servers.md#personal-credentials) now says that a personal
    credential must be a high-entropy secret, since its fingerprint is an
    unsalted SHA-256 prefix. It also says that the person's pipe, not the
    receiver's terminal check, keeps the value off a terminal.
