## Fixed

- **A spawn whose caller went away no longer ends as a failure, or with a
  home that has no record.** When the reader of `oats spawn` closed stdout
  or stderr while it ran (an ssh session that ended), the spawn completed
  and then ended with an unhandled `EPIPE` and exit status 1, as if it had
  failed. It now ends with the spawn's own status, `0`, as `oats worktree
  add` does; the answer nobody read is the home's record, and a spawn
  repeated with the same `--expect-decision` and `--idempotency-key`
  answers it again. A SIGINT, SIGTERM or SIGHUP that arrived while the
  capabilities were copied into the new home ended the process there and
  left a home with no `instance.json`, which only `oats retire --force`
  removed. The signal is now held until the copy ends: the home is removed
  and the spawn answers `E_INTERRUPTED` (`details: {signal, hooks: []}`),
  exit 128 + the signal number, as it does while its `worktree` hooks run
  ([a caller that goes away](../desktop-cli-api.md#spawn-caller-gone)).
