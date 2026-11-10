## Fixed

- **`oats retire` refuses a flag it does not read.** `oats retire <instance>
  --keep-dirs`, a typo for `--keep-dir`, was accepted, the flag was ignored,
  and the instance's home was removed.
  - A flag retire does not define, or an argument after the instance, is
    refused with `E_BAD_ARGS` before anything happens: before `--plan`
    answers, a child is stopped, a hook runs, or a `--server` retire is sent
    to its host. The message names the flag (`oats retire: unknown flag
    --keep-dirs`) and prints the usage; under `--json` the envelope carries
    `error.details.flag` or `error.details.argument`.
  - The flags retire reads are `--plan`, `--plan-revision`,
    `--idempotency-key`, `--home`, `--dir`, `--server`, `--self`,
    `--discard-worktree`, `--keep-dir`, `--force` and `--json`
    ([Retire](../souls-and-instances.md#retire)). A script that passes
    `oats retire` any other flag, such as `--agents-root`, which retire never
    read, gets the refusal: remove the flag.
