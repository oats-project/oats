## Changed

- **`oats host run` runs the resume sweep each minute, not only at its
  start.** An agent whose session is lost while the host runs (its harness
  crashed or was killed) is started again by the sweep of the next minute,
  within the sweep's own bounds: at most 3 starts of a home in an hour, a
  refused start retried with backoff, and a home given up after 3 such hours
  in a row. Before, a container that stayed up never started a lost agent
  again; only a restart of the container did.

  The sweep replaces the listing `oats host run` ran each minute, and records
  what that listing recorded. A sweep that still runs at the next minute is
  not run beside itself. Progress says a sweep only when its outcomes differ
  from those of the sweep before. The answer's `sweep` is the first sweep's.
  Stopping is unchanged: a sweep that runs gets the same 10 seconds, and the
  admission fence stops its further starts.
