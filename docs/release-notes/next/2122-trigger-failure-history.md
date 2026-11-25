## Added

- **A trigger keeps its failed spawns as rows** (#2122, KP-15). `oats
  trigger status --json` answers `failures`, newest first and at most 50,
  and `failuresTotal`, every failed spawn since the trigger was added (it
  outlives the 50 rows and a restart). A row is `{attempt, at, key, event,
  subject, number, code, message}`, with `instance` and `home` when the
  spawn left a home; there is one row per attempt of an event, and its
  earlier rows gain `resolved: {at, instance}` when a later attempt spawns.
  Every text is bounded and made safe to show. `lastError` is unchanged.
  Feature `trigger-failure-history`
  ([schedules.md](../schedules.md#failed-spawns)).
