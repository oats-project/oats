## Fixed

- **A scheduled spawn with `yolo: true` on a session provider that launches
  only in full mode can be saved.** `oats schedule add` and `update` of a
  spawn job whose soul this deployment had not spawned yet refused it
  (`E_SCHEDULE_INVALID`, `details.code: "E_BACKEND_SANDBOXED_MODE"`), and
  `oats schedule test` said its soul did not resolve, although the job's run
  launched: their preview of the spawn did not carry the job's `yolo`, and a
  preview asks the provider's `check` with the launch that is planned. The preview now carries the job's `yolo`, as a trigger's does
  ([spawn](../schedules.md#kinds)). A job with no `yolo` on such a provider
  is still refused when saved; one saved without the preview fails at each
  run, `launch-failed` with `errorCode: "E_BACKEND_SANDBOXED_MODE"`, and
  leaves no home.

## Documentation

- **Schedules and triggers on a session provider**
  ([Kinds](../schedules.md#kinds), [Triggers](../schedules.md#triggers)): a
  scheduled or triggered spawn on a provider that launches only in full mode
  needs `yolo: true` in its definition, or a launch configuration that sets
  it; a wake is the input of a provider home's session, and never starts a
  stopped provider home. Tests now cover a wake, a scheduled spawn and a
  triggered spawn on a session provider.
