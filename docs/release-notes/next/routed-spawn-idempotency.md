## Changed

- **A spawn through a server is bound to the server's preview and a key.**
  `oats spawn <soul> --server <id>` asks the server for its preview, then
  spawns with that decision and a key made for the request
  (`--expect-decision`, `--idempotency-key`): one more call to the server
  per spawn. Its `--json` answer is the server's keyed answer, with
  `decision`, `replayed` and `wake` beside the fields it had. A name another
  spawn takes between the two calls is `E_DECISION_STALE` and nothing is
  created: run the spawn again. `--suggest-name` is given to the preview,
  and the spawn carries the name it chose. A spawn that brings
  `--expect-decision` or `--idempotency-key` travels as given
  ([Run there](../servers.md#run-there)).
- **A server that does not advertise `spawn-preview-2`, `spawn-apply-2` and
  `spawn-idempotency-2` gets the spawn in one call, as given,** and the
  answer carries a warning that a dropped link cannot be retried safely
  there.

## Fixed

- **A spawn whose link dropped while the server spawned can be run again
  onto the one instance.** The failure is `E_SSH`, its message ends with the fix, and
  `--json` carries `error.details: {decision, idempotencyKey, fix}`. The same
  spawn with `--expect-decision <decision.revision> --idempotency-key
  <idempotencyKey>` answers the instance the first attempt created
  (`replayed: true`) and saves its route
  ([ssh failures](../desktop-cli-api.md#ssh-failures-e_ssh)).
- **A replayed keyed spawn answers `attach`,** as the first apply did.
