## Upgrade

- **A capture lock or a stream lock written by an earlier version is still
  judged as that version judges it.** Its record names neither a boot nor a
  process start: the capture lock (`<record root>/.capture.lock`) is
  reclaimed only when it names this host and its pid is gone, and a stream
  lock (`streams/<id>/.lock`) by its pid on this host, or by its age when it
  names another. One left on a volume by a container that ran an earlier
  version can therefore still stop capture for that root after the upgrade:
  the pass names the lock and the command that removes it. Locks this
  version writes do not need that.
- **A record root is written from one machine at a time.** A lock taken on
  another machine was taken in another boot, so it is reclaimed at once
  though its holder may be running there. Earlier versions never reclaimed
  another host's capture lock, and reclaimed another host's stream lock only
  after 30 s. A record root that two machines write at once (a home on NFS)
  is no longer serialized between them
  ([turn record: Durability and concurrency](../../packages/record/README.md#durability-and-concurrency)).

## Fixed

- **A capture lock or a stream lock whose holder is gone no longer stops
  capture when the container is created again.** Both locks of the turn
  record named their holder by pid and hostname. On a volume that outlives
  its container, a lock left by a stopped container named a hostname the
  next container does not have, so the capture lock was never reclaimed and
  every pass skipped, and a pid that the next run had given to another
  process, so the lock read as held. Both records also name the boot the
  lock was taken in and the holder's process start (`bootId`,
  `processStart`), as the kernel's claims do, and are judged by the same
  code: a lock taken in another boot (a container run counts as one), or
  whose pid is gone or runs with another start, is reclaimed at once,
  whatever host it names. The capture lock's registered worker and its
  reclaim guard are judged the same way. A holder that is still running is
  never taken over, and a pass that finds one says that it skipped, naming
  it ([turn record: Durability and concurrency](../../packages/record/README.md#durability-and-concurrency),
  #1812).
- **The standalone `turn-record` package judges its locks as an OATS
  install does.** The process start token, the boot id and the rule for a
  record of another boot are one dependency-free module of the package,
  `packages/record/lib/process-identity.mjs`, which the kernel imports
  ([Implementation](../implementation.md)).
