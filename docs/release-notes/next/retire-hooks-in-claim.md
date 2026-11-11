## Changed

- **A retire's lifecycle claim records the retire hooks that ended.** The
  claim file of a home (`<instances>/.oats-retirement/claims/<name>.lock`)
  gains two fields while a retire holds it: `retireHooks`, a list of
  `{capability, meta?}` for each retire hook that ended, with the `meta` it
  answered, and `retireHooksFor`, the `createdAt` of the home they ran for.
  This is an addition to the claim's format. An earlier OATS that takes
  such a claim over ignores the fields and runs every retire hook, as it
  always did. This OATS, taking over a claim without them, runs every
  retire hook too. Nothing is written into the home
  ([One retire at a time](../desktop-cli-api.md#retire-hooks-in-claim)).

## Fixed

- **A retire that takes over from a killed one no longer runs again the
  retire hooks that one had finished.** A retire, or the detached
  completion of a self-retire, that was killed after some of its retire
  hooks had returned (a `SIGKILL`, a container that stopped) left nothing
  that said so, and the next `oats retire` of the home ran every hook a
  second time. The next retire now reads
  the finished hooks from the claim the killed one left, skips them, and
  judges the cleanup and writes its `retired` row with what they answered.
  A hook that had not ended when the retire was killed is run again. The
  retry of a quarantined home, and the retries a self-retire's completion
  makes of a cleanup its hooks left incomplete, run every hook again, as
  before
  ([One retire at a time](../desktop-cli-api.md#retire-hooks-in-claim)).
