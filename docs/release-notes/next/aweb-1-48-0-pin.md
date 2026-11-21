## Upgrade

- **OATS pins oats.aweb 1.48.0, which needs OATS 0.70.0 or later.** Upgrade
  the CLI to 0.70.0 or later before `oats sync` takes the pin: an older kernel
  refuses the package. Running instances keep the module they were spawned
  with: respawn them, or move a stopped one with `oats instance upgrade`, to
  take 1.48.0.

## Changed

- **OATS pins oats.aweb 1.48.0** (from 1.47.0). The package's requirements
  follow the session backend: the channel packages (`aweb-channel`,
  `@awebai/pi`) are required of `tmux` launches only, and a session provider's
  launch holds an installed `aweb-channel` to 1.7.9 and an installed
  `@awebai/pi` to 0.3.10, so no older package opens its own mail stream beside
  the wake broker's. A retire removes a provider home's broker registration
  when either record names a session provider. Homes on tmux behave as before.
