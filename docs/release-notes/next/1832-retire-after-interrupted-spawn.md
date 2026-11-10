## Changed

- **A home whose record does not say which retire hooks to run is refused by
  `oats retire`, where it was removed with a warning.** A record that names
  no repository and does not show that no capability has a retire hook (the
  stub a spawn leaves when it is killed before its record) is refused with
  `E_UNIDENTIFIED_INSTANCE_HOME` before anything is stopped, run or removed,
  unless a usable cleanup marker is beside it. Clean up by hand what the
  home's capabilities registered, then `oats retire <instance> --force`
  removes it, running no hook
  ([capabilities.md](../capabilities.md#manifest)).
- **`spawnInProgress: true` on a status row, and `E_LIFECYCLE_BUSY` from a
  retire, also cover a spawn that is running its spawn hooks**, when a
  capability with a spawn hook has a retire hook. Before, only a spawn
  running its `worktree` hooks read that way.

## Fixed

- **A spawn killed inside its spawn hooks no longer leaves a registration
  that nothing can release.** `oats spawn` ran its spawn hooks (a
  capability's may register an identity with an external service and take a
  seat) and wrote the home's record only later. A spawn killed in between
  (SIGKILL, a container stop, a dropped connection) left a home whose record
  named neither a repository nor its capabilities; `oats retire` then ran no
  retire hook, removed the home and the keys in it, and exited 0 with a
  warning.
  - The spawn now writes its in-progress marker
    (`.oats-rollback-incomplete.json`) before its first spawn hook, in every
    work mode, when a capability with a spawn hook has a retire hook: the
    repository, the capabilities with their hooks, the soul, and the record's
    `workspace`, `teams` and `defaultTeam`. It writes it again with the spawn
    hooks' receipt once they have answered, and removes it when the final
    record is written.
  - `oats retire` of the home such a spawn leaves runs the retire hooks,
    with the environment a retire of a whole home gives them, and then
    removes the home. A retire hook that runs after a spawn hook that never
    answered gets an empty `OATS_META`.

## Documentation

- [capabilities.md](../capabilities.md#manifest) states the rule for retire
  hooks: one must be safe to run when its spawn hook did not finish and when
  it has run before.
