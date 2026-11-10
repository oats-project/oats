## Fixed

- **Inside a container, `oats session resume` counts a boot per run of the
  container.** A container shares its host's kernel, so the kernel's boot id,
  which the sweep read as the boot, stayed the same when the container was
  stopped and started, although every session in it was gone. With
  `~/.oats` on a volume, the third restart of a container within one host
  uptime used up the 3 sweep starts a home has per boot, and the sweep then
  answered `keeps-getting-lost` for sessions lost with the container; a
  session lost with a container that stayed down for a day or more was
  answered `not-seen-recently`, since the 24-hour clause of one boot applied
  across the restart. The boot in a container is the kernel's boot id
  together with the start time of the container's PID 1 (`/proc/1/stat`),
  which is the same all through one run and another in the next. On a Linux
  host, where PID 1 starts with the kernel, and on macOS the boot is what it
  was, and the sweep's records stay valid; in a container the first sweep
  after the upgrade starts a new count
  ([Execution targets](../execution-targets.md#the-sweep)).
