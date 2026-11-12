## Upgrade

- A legacy lock written before 0.69.15 without `processStart` may need a
  one-time operator clear after a container restart. OATS keeps an unknown
  holder held instead of taking it over: once no holder runs, clear the
  reported lock path and start again.

## Fixed

- Linux lock holders and readers use the kernel boot UUID consistently,
  including SSH commands and the entrypoint sharing a container's PID
  namespace. Unmarked PID sandboxes keep the host's boot string; holder
  liveness still requires a visible pid, without cross-namespace translation.
  Historical qualified UUIDs remain compatible with visible live holders across
  upgrades. Crash budgets and refusals carry across same-kernel container
  restarts; successful restores after a host stop neither consume nor reset
  that budget and cannot be suppressed by its ceiling. A validated
  current-start host-stop timestamp excludes downtime from the in-boot
  eligibility gap, preserving clean restores after more than 24 hours;
  other loss/refusal guards remain. See
  [Session recovery](../execution-targets.md#which-losses-come-back).
