## Upgrade

- **Tighten a record root that an earlier version wrote.** The turn-record
  store now creates its files and directories for their owner alone (see
  Fixed below), and it never changes the permissions of what already exists:
  journals, objects and index databases written before this release keep the
  mode they were created with, `0644` and `0755` under the usual umask. On a
  host with more than one user, run once, for each record root (the `--root`
  given to capture, else `$TURN_RECORD_ROOT`, else `~/.turn-record`):

  ```sh
  chmod -R go-rwx ~/.turn-record
  ```

  A process that reads a record root as another user, or through a group,
  can no longer read what the store creates from this release on; run it as
  the root's owner.

## Fixed

- **The turn-record store creates transcripts private to their owner.** The
  store created journals, objects, quarantined copies and its index
  databases with the process's default permissions, so on a shared host
  other users could read agents' conversations. It now creates files with
  mode `0600` and directories with mode `0700`:
  [Store layout](../../packages/record/docs/turn-record-sot.md#store-layout)
  has the rule, and what it does not cover (a root that a capture pass's
  lock is the first to create).
