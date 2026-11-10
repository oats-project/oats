## Fixed

- **`oats session resume` takes over the lock of a sweep that is gone at
  once, and never mistakes another process for it.** The sweep's lock
  (`~/.oats/session-resume/lock`) named its holder by pid alone within one
  boot: when a sweep was killed and its pid went to another process, every
  later sweep answered `E_RESUME_BUSY` until that process ended, and a sweep
  killed just as it took the lock stopped the others for a minute. The lock
  is now a file that names its holder by pid, start time and boot, as the
  kernel's other locks do: the next sweep takes over a lock whose holder
  exited, was killed (a container's stop included) or took it in another
  boot, with no wait. A sweep that is still running is never taken over, and
  a second sweep answers `E_RESUME_BUSY` as before. Three cases need the
  operator, are answered `E_RESUME_BUSY` too, and the message says which it
  found and names the path to remove: a lock whose record is unreadable, a
  holder that cannot be told to be running or gone, and a gone holder's
  record that cannot be taken over. A lock directory left by an earlier OATS
  needs nothing: it is busy while that OATS's sweep runs and removed once it
  does not. An earlier OATS on the same machine takes the new lock over once
  it is a minute old, also from a sweep that still runs, so run one OATS
  version per machine
  ([Execution targets](../execution-targets.md#the-sweep)).
