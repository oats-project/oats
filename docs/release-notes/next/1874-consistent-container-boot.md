## Fixed

- Linux lock holders and readers use the kernel boot UUID consistently,
  including SSH commands in containers and commands in PID sandboxes.
  Historical qualified UUIDs remain compatible with live holders across
  upgrades. Crash budgets and refusals carry across same-kernel container
  restarts; successful restores after a host stop neither consume nor reset
  that budget and cannot be suppressed by its ceiling. See
  [Session recovery](../execution-targets.md#which-losses-come-back).
