## Upgrade

- **A flag these commands never defined is now refused, where it was
  ignored** (oats-project/oats#1824). A typo of a real flag is now refused
  before anything happens: `oats schedule host install --prnt` installed the
  host timer and `oats schedule tick --dry-rn` ran the tick; both are now
  refused with `E_BAD_ARGS`. Check scripts and schedules that call `oats
  instance`, `oats schedule`, `oats trigger`, `oats session`, `oats server
  check` or `oats update`: what is now refused is listed under Fixed below,
  and the flags each command defines in
  [The flags a command defines](../desktop-cli-api.md#command-flags).

## Fixed

- **The rest of the commands that change state refuse a flag they do not
  define** (oats-project/oats#1791, after #1813). These read the flags they
  knew and ignored every other one: `oats instance color`, `background`,
  `same-work`, `waiting set|clear` and `attention`; `oats schedule add`,
  `update`, `tick` and `host install`; `oats trigger add`, `poll` and
  `test`; `oats session input`, `receive`, `upload` and `attach`; `oats
  server check`; and `oats update`. A typo of one of their flags did the
  thing without it: `oats schedule host install --prnt` installed the host
  timer where `--print` only prints its files, and `oats schedule tick
  --dry-rn` ran the tick.
  - Each of them now refuses, with `E_BAD_ARGS` and before anything
    happens, a flag it does not define, a value given with `=` to one of its
    switches, and an argument after the last one it takes, with the same
    words as the commands of #1813 (`oats schedule tick: unknown flag
    --dry-rn` and the usage line; `error.details.flag` or
    `error.details.argument`). A routed one (`--server`) missing an argument
    it requires is `E_USAGE` here, and nothing is sent.
  - A script that passes one of these commands a flag it never defined gets
    the refusal where the flag was ignored: remove the flag. Among them:
    `--dir` on `oats session input`, `receive`, `upload` and `attach` (they
    take `--home`), `--server` on `oats trigger add`, `poll` and `test`
    (which have no route), `--clear` on `oats instance waiting` (it is
    `oats instance attention`'s), and anything after `oats update`'s own
    flags. `--server` on `oats instance waiting`, `oats instance attention`,
    `oats session input` and `oats session receive`, which have no route, is
    `E_BAD_ARGS`, unknown flag, where it was `E_USAGE` from the router. The flags each command defines
    are listed in
    [The flags a command defines](../desktop-cli-api.md#command-flags).
- **The commands that already refused a flag they do not read check it in
  the same place**: `oats spawn`, `oats sync`, `oats session resume`, `oats
  instance suggest-name`, `oats teams` and `oats soul launch set|remove`.
  Their answers keep their words: `oats teams` and `oats soul launch` still
  answer `E_USAGE {flag}`, `oats spawn` its own `unknown flag` and
  capability-setting words. What changed:
  - `oats spawn --instructions-file`, `--def-file` and `--ephemeral` are
    refused in their own words on a `--server` spawn too, where they were an
    unknown flag, and carry `error.details.flag`. `oats spawn <soul> -x` is
    `oats spawn: unknown flag -x`, where it was an unexpected argument.
  - `oats instance suggest-name` says `unknown flag <flag>` with the usage
    line and `error.details.flag`, where it said `unexpected flag "<flag>"`;
    `oats session resume`'s refusal carries `error.details.flag` or
    `error.details.argument`, and an argument is `unexpected argument
    "<word>": session resume takes no argument`. `oats sync <word>` is
    `sync takes no argument`, where it said `sync takes no positional`.
  - `oats teams add|remove|default <label> <word>` refuses the second word,
    which it ignored; `oats teams --dir <d> add <label>` (a flag before the
    form) is refused with the forms' usage, where it listed the teams.
  - `oats instance background|same-work <instance> on off` is `unexpected
    argument "off" after the state "on"`, where it said `give on or off`.
