## Fixed

- Capability commands routed with `--server` refuse `--invite <token>` and
  `--invite=<token>` before ssh starts. Use `--invite-stdin` and a pipe instead.
- The agent-permissions setup example asks before `aw` selects another identity,
  human principal or team, and leaves mail acknowledgement to the classifier.
