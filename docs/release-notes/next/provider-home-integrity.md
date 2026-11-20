## Added

- **A provider home is run by its receipt, not by what is in it.** A session
  provider may run its harness in a sandbox that still lets the agent write
  its own home, and the kernel that runs the home's hooks and the
  provider's commands runs outside any sandbox. For a home on a session
  provider the kernel now takes nothing it runs from the home alone
  ([What the kernel trusts in a provider home](../capabilities.md#what-the-kernel-trusts-in-a-provider-home)):
  - The home's receipt, outside the home, records its `composition`: the
    digest and size of every module copy as the spawn made it, and the
    capability rows the spawn resolved (settings, their origins, hook
    commands, levels). `oats instance upgrade` rewrites it in the step that
    moves the copies.
  - A module copy is run only when it digests to that record, hashed whole
    at every use and never cached: a provider's command, a lifecycle hook,
    a worktree hook, a capability's readiness check, and a command or an
    operation dispatched in the home. A launch checks every copy first.
  - `OATS_SETTINGS`, `OATS_SETTINGS_ORIGINS` and the hook commands of such a
    home come from the receipt, never from `instance.json`.
  - A copy that differs refuses the call, naming the module. A read shows
    the home unavailable (`E_SESSION_UNAVAILABLE`; `running: null`,
    `runtimeState: "unreachable"`), never stopped. A hook that may not run
    counts as a failed required hook. The remedy is to retire the instance
    and spawn it again.
  - Measured on a developer laptop: a module copy of 0.96 MB in 82 entries
    hashes in 0.9 ms, and the five module copies of a home (1.1 MB) in 1.2
    ms. A status row of a provider home costs one hash of its provider's
    copy and a read of its receipt, and each call to the provider one more.
- **The launch input and the check's planned launch carry `trees`**: the
  home's `work/`, then every extra tree Git itself lists for the home, as
  absolute paths. A provider that sandboxes keeps each tree's Git pointer,
  configuration and hooks unwritable. Additive; the wire stays 1.3.
- **`OATS_PREVIOUS_BACKEND`** for launch hooks: the backend the home was
  last launched on, as its receipt records it (`tmux` or a provider's
  name); absent at a first launch. A capability that keeps files of its own
  in a home for one backend removes them only when this names that backend.

## Changed

- **Every Git the kernel runs over a provider home's trees runs with the
  repository's hooks and its file monitor off**: now also a spawn's `git
  worktree add` and its rollback, and `oats worktree add` and `remove` (the
  reads and a retire already did, for every home). A tmux home's Git is
  unchanged.
- **An append to an instance's event log never writes through a link.** The
  home's log and the deployment's are opened without following a symbolic
  link, and written only when they are a regular file with one name: a
  symbolic link, a hard link and a FIFO at a log's name are refused, as the
  reader already refuses them. The other log still gets its row.
- **`oats instance upgrade` of a provider home** starts only from module
  copies its receipt records, is not undone (`--undo` is refused,
  `E_UPGRADE_UNDO`), and is not resumed after an interruption
  (`E_UPGRADE_PARTIAL`): the copies it would restore and the journal it
  would resume from are in the home. An interrupted upgrade of such a home
  is finished by retiring and respawning it.

## Upgrade notes

- **A provider home spawned by an earlier kernel must be respawned.** Its
  receipt has no `composition`, so this kernel runs none of its
  capabilities: its session reads unavailable, and every verb's message
  says to retire it and spawn it again. `oats retire <name> --force` removes
  it (its retire hooks are not run, and the retire says which). The
  session-provider wire has been experimental so far, and no released
  provider exists; tmux homes are not affected.
- **For a provider's author:** if your provider sandboxes its harness, keep
  `<instances>/.oats-retirement/` unwritable from the session (the receipts
  are there), and deny writes to the Git pointer, configuration and hooks
  of each path in `trees`. Nothing in this release makes a provider's
  sandboxed mode a security boundary between an agent and the operator's
  account.
