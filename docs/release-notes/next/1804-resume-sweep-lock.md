## Upgrade

- **After upgrading, remove a sweep lock directory the earlier OATS left.**
  A directory at `~/.oats/session-resume/lock` is the earlier OATS's lock.
  This OATS never judges or removes it: `oats session resume` refuses it
  with `E_RESUME_LOCK_STUCK`, and no sweep starts anything on the machine
  until you remove the directory by hand, once no earlier `oats` is running
  there. `oats doctor` reports it. An earlier OATS on the same machine takes
  the new lock over once it is a minute old, also from a sweep that still
  runs, so run one OATS version per machine.

## Added

- **`E_RESUME_LOCK_STUCK`: a sweep lock that needs a person has its own
  code, and `oats doctor` reports it.** `oats session resume` answers it,
  never `E_RESUME_BUSY`, when the lock cannot be taken and no sweep is known
  to run: a record that cannot be read, a holder that cannot be told to be
  running or gone, a gone holder's record that cannot be taken over, or the
  earlier OATS's lock directory. The message says which it found and names
  the path to remove, and `error.details` is `{lock, found}`. `oats doctor`
  lists the same states as a `resume-lock-stuck` problem, reading the lock
  without taking it
  ([The machine sweep](../desktop-cli-api.md#the-machine-sweep-oats-session-resume)).

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
  a second sweep answers `E_RESUME_BUSY` as before
  ([Execution targets](../execution-targets.md#the-sweep)).
