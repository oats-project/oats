## Upgrade

- **Earlier OATS versions on the same machine still judge a cache write lock
  by its pid alone.** A cache that an earlier `oats` also writes keeps that
  behaviour for the locks it meets: it waits for a lock whose pid another
  process holds, and so does this OATS for a lock the earlier one wrote,
  whose record names no boot or start time. Run one OATS version per
  machine to have every cache write lock judged by its holder's identity.

## Fixed

- **A cache write lock whose holder is gone no longer stops writes to the
  cache when its pid belongs to another process.** The cross-process write
  lock of a remote cache repo (`<cache>/.locks/<repo>.lock`) named its holder
  by pid alone: when the holder died and its pid went to another process
  (after a reboot pids start low again), every write to that cache waited
  out the whole deadline and was refused with `E_REMOTE_UNREADABLE`
  (`reason: "cache"`) until that process ended, which could take days. The
  lock's record also names the boot it was taken in and its holder's start
  time, as the kernel's other locks do, and a lock taken in another boot, or
  whose pid runs with another start, is reclaimed at once. A holder that is
  still running is never taken over. The refusal for a lock that is held
  says to check whether the named pid is an oats process, and that once no
  oats process holds it, the lock file it names is safe to remove
  ([Implementation](../implementation.md)).
