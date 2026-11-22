## Fixed

- **Readiness: a Claude or Codex home on a session provider no longer shows
  its folder trust as `unknown`.** The `harness-trust` item of
  `oats readiness` for a home that runs on a session provider (for example
  bb) read "folder trust is not established … a session provider runs this
  launch, which has no pane", status `unknown`, on every such home. The
  provider runs the harness with no OATS pane, so no file is read for it: the
  item is now `not-applicable`, with `file` null, and the provider's own
  readiness item answers for its launch
  ([Launch-time checks and readiness](../harness-trust.md#launch-time-checks-and-readiness)).
