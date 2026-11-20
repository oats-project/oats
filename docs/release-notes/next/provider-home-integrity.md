## Added

- **The kernel runs its own copy of a provider home's modules, never the
  home's.** A session provider may run its harness in a sandbox that still
  lets the agent write its own home, and the kernel that runs the home's
  hooks and the provider's commands runs outside any sandbox, while that
  agent runs. For a home on a session provider the kernel now runs nothing
  that is in the home
  ([What the kernel trusts in a provider home](../capabilities.md#what-the-kernel-trusts-in-a-provider-home)):
  - The kernel keeps its own copy of the home's modules outside the home,
    at `<instances>/.oats-retirement/modules/<hash of the home>/<store>/`,
    made once by the spawn before the provider is asked to launch. Every
    lifecycle hook and worktree hook, every command of the provider, every
    capability's readiness check and every command or operation dispatched
    in the home runs from it, and the home's manifests are read there. The
    copies in the home stay, for the agent and its harness.
  - The home's receipt records its `composition`: which store holds those
    copies, which modules the home has and where each came from, and the
    capability rows the spawn resolved (settings, their origins, hook
    commands, levels). `OATS_SETTINGS`, `OATS_SETTINGS_ORIGINS` and the hook
    commands of such a home come from the receipt, never from
    `instance.json`.
  - A retire removes the kernel's copy with the home. `oats instance
    upgrade` makes the copies for the upgraded home in a new store and then
    writes the receipt once, naming the new store and the new rows together:
    an upgrade that fails or is killed before that write leaves the old copy
    and the old rows, and `--undo` names them again.
  - A provider home's status row, its remote roster row and a start's
    answer gain an optional key beside `modules`, `moduleCopy: {runs:
    "kernel-copy", homeCopy: "same" | "differs", differs}`: which copy the
    kernel runs, and whether the home's own record of its modules is the
    kernel's (records only, nothing hashed). `oats readiness --home` of a
    provider home gains `kernelCopies: {store, differing}`, which compares
    the files. `modules` is unchanged.
  - Nothing is hashed at a call, so a read of a provider home costs no more
    than before. The cost is disk: a provider home's modules are kept twice
    (about 1.3 MB for a home with the usual capabilities).
- **The launch input and the check's planned launch carry `trees`**: the
  home's `work/`, then every extra tree Git itself lists for the home, as
  absolute paths. A provider that sandboxes keeps each tree's Git pointer,
  configuration and hooks unwritable. Additive; the wire stays 1.3.
- **The launch input and the check's planned launch carry `protected`**:
  the kernel's own state for the home, today `<instances>/.oats-retirement/`:
  paths a sandboxed agent must never write, and that a provider must not
  block reading or executing. The kernel makes each directory before the
  launch. Additive; the wire stays 1.3.
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
- **`oats instance upgrade` of a provider home** takes its module set and
  each module's source from the receipt (a module only the home's record
  names refuses it), runs each upgrade hook from the kernel's copy, and
  keeps the pair it replaced, so that `--undo` names the kernel's previous
  copies and rows again in one write. It is not resumed after an
  interruption (`E_UPGRADE_PARTIAL`): the journal it would resume from is
  in the home. The kernel's side is whole either way; undo it, or respawn.

## Upgrade notes

- **A provider home spawned by an earlier kernel must be respawned.** Its
  receipt has no `composition`, so this kernel runs none of its
  capabilities: its session reads unavailable, and every verb's message
  says to retire it and spawn it again. `oats retire <name> --force` removes
  it (its retire hooks are not run, and the retire says which). The
  session-provider wire has been experimental so far, and no released
  provider exists; tmux homes are not affected.
- **For a capability's author:** in a provider home your hooks and commands
  run from the kernel's copy of your capability, not from
  `<home>/.oats/modules/<capability>/`. Find the home by
  `OATS_INSTANCE_HOME`, never by your own location, and never write beside
  your own code.
- **For a provider's author:** if your provider sandboxes its harness, keep
  `<instances>/.oats-retirement/` unwritable from the session (the kernel's
  copies of the modules and the receipts are there) and leave it readable,
  and its `modules/` executable, at the same path (a hook hands the harness
  scripts there); the launch input names it in `protected`, and deny writes to the Git pointer, configuration and hooks
  of each path in `trees`. Nothing in this release makes a provider's
  sandboxed mode a security boundary between an agent and the operator's
  account.
