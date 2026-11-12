## Fixed

- **A routed spawn whose `oats` on the server was killed can be retried
  safely.** When the server's `oats` ended without an answer
  (`E_REMOTE_ENVELOPE`) the error did not carry the decision and the key of
  the attempt, so the same spawn run again created a second instance. It now
  carries them as a dropped link (`E_SSH`) does: the message ends with the
  fix, and `--json` has `error.details: {decision, idempotencyKey, fix}`.
