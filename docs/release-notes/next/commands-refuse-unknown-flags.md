## Fixed

- **The commands that change state refuse a flag they do not define**
  (oats-project/oats#1791). `oats instance stop`, `oats instance upgrade`,
  `oats worktree add` and `remove`, `oats session start` and `restart`,
  `oats schedule remove`, `run`, `enable`, `disable`, `reconcile` and
  `host uninstall`, `oats trigger remove`, `enable` and `disable`, `oats
  server remove` and `forget`, `oats package add` and `remove`, `oats
  launch-config set` and `remove`, and `oats automations refresh` read the
  flags they knew and ignored every other one, so a typo of a protective
  flag did the unprotected thing: `oats instance stop <instance> --apply
  ... --no-recursve` also stopped the recorded children, and `oats instance
  upgrade <instance> --undoo --plan` planned the forward upgrade.
  - Each of them now refuses, with `E_BAD_ARGS` and before anything
    happens (before a plan is read, a file is written, a session is stopped
    or started, and before a `--server` command is sent to its host), a
    flag it does not define, a value given with `=` to one of its switches
    (`--undo=yes`), and an argument after the last one it takes. The message
    names the flag and the command and prints the command's usage
    (`oats instance stop: unknown flag --no-recursve`); under `--json` the
    envelope carries `error.details.flag` or `error.details.argument`.
    `oats retire` refuses the same way, with the same words as before.
  - A script that passes one of these commands a flag it never defined gets
    the refusal where the flag was ignored: remove the flag. Among them:
    `--dir` on `oats session start` and `restart` (they take `--home`),
    `--stop-grace` on `oats session start` (it is `restart`'s), and
    `--server` on `oats trigger remove`, `enable` and `disable`, which have
    no route and changed the trigger on this machine. The flags each command
    defines are listed in
    [The flags a command defines](../desktop-cli-api.md#command-flags).
  - The refusals some of these commands made of one flag in their own words
    (`--server` on `oats instance upgrade`; `--server`, `--dir` and `--home`
    on `oats worktree`; `--home` and `--soul` on `oats launch-config set`
    and `remove`; `--resume` on `oats session restart`) keep their words,
    carry `error.details.flag`, and now also come before a `--server`
    command is sent. `oats worktree remove` given `--branch`, `--base`,
    `--repo` or `--preview` answers `unknown flag` with its usage.
  - `oats retire --json <instance> ...`, with `--json` before the
    instance, answers its refusal as one envelope.
