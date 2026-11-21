## Changed

- **A spawn job on a session provider is checked by the provider when it is
  saved.** A spawn's preview now asks a session provider's `check` with the
  launch that is planned, and `oats schedule add`, `update` and `test` ask
  that preview with the job's own launch selection, its `yolo` included
  ([spawn](../schedules.md#kinds)). On a provider that launches only in full
  mode:
  - a job with `yolo: true` is saved and launches, as one whose launch
    configuration sets yolo does (a build with the preview's new check and
    without this change refused the job's own `yolo: true` on `add` and
    `update`, and `oats schedule test` said its soul did not resolve: the
    schedule's preview did not carry it);
  - a job with no `yolo` is refused when saved (`E_SCHEDULE_INVALID`,
    `details.code: "E_BACKEND_SANDBOXED_MODE"`), and `oats schedule test`
    reports it, where it used to fail only at its run. One the
    save did not ask the provider about (its soul was already spawned in
    the deployment, or the provider comes from a member module, which a
    preview does not ask) fails at each run, `launch-failed` with `errorCode:
    "E_BACKEND_SANDBOXED_MODE"`, and leaves no home.

## Documentation

- **Schedules and triggers on a session provider**
  ([Kinds](../schedules.md#kinds), [Triggers](../schedules.md#triggers)): a
  scheduled or triggered spawn on a provider that launches only in full mode
  needs `yolo: true` in its definition, or a launch configuration that sets
  it; a wake is the input of a provider home's session, and never starts a
  stopped provider home. Tests now cover a wake, a scheduled spawn and a
  triggered spawn on a session provider.
