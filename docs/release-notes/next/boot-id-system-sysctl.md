## Fixed

- **On macOS, the boot id is read with the system's `sysctl`, whatever the
  caller's `PATH`.** It was read with the first `sysctl` on `PATH`, so under a
  `PATH` without `/usr/sbin` (a scheduled job, a reduced environment) it read
  none. The boot rule was then off without a word: the resume sweep's count
  of starts per boot and its lock, and the cache write lock's holder check,
  judged by process alone, and a lock taken before a reboot could be held by
  a pid the new boot reused. The system directories the kernel runs its tools
  from are `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin`, in that order.
