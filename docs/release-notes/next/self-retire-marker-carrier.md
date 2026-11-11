## Fixed

- **A self-retire whose completion was killed says what to run, and a
  reboot no longer hides that it was killed.** `oats retire <instance>
  --self` schedules the retire in a detached completion and leaves a pending
  marker beside the home. When that completion was killed before it
  finished (a `SIGKILL`, a container that stopped), `oats session start`
  answered `<instance> is being retired`, which was not true and named no
  way out. It now answers `E_INSTANCE_RETIRING` with `<instance> is owed a
  retire (its retire was interrupted): finish it with` and the `oats retire`
  command, which takes the retire over and completes it. The marker also
  records the boot its completion runs in (`completionBoot`): after a
  reboot or a container restart, a marker whose pid and start had both come
  again read as a retire still running, and `oats retire` was refused
  `E_LIFECYCLE_BUSY` for a completion that no longer existed. Such a marker
  now names a completion that is gone. A marker written by an earlier OATS
  names no boot and is judged by its process alone, as before
  ([a completion that was killed](../souls-and-instances.md#self-retire-interrupted)).
