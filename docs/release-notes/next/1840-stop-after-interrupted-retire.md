## Fixed

- **A stop is not refused by a self-retire whose completion is gone.** A
  scheduled self-retire whose detached completion was killed, or that
  failed after its hooks started, leaves its pending marker, and every stop
  of that home answered `E_INSTANCE_RETIRING`: `oats instance stop
  --apply`, a retire's stop of a recorded child, and the stop `oats host
  run` makes of every running home on SIGTERM, which reported a failed stop
  on each container stop. The marker now holds the home against a stop only
  while the completion it names is not gone. Once it has ended, runs with
  another start, or belongs to another boot, the stop plan shows `retiring:
  false` for that target and the session is stopped; the marker stays, and
  the home is still owed its retire (`oats retire <instance>`). A
  completion that lives, and a marker that names none, refuse a stop as
  before
  ([a completion that was killed](../souls-and-instances.md#self-retire-interrupted)).
