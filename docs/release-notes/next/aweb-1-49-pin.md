## Upgrade

- **OATS pins oats.aweb 1.49.1** (from 1.48.0). Its floor stays OATS 0.70.0.
  Running instances keep the module they were spawned with: respawn them, or
  move a stopped one with `oats instance upgrade`, to take 1.49.1. A private
  deployment publishes its namespace authority in DNS; for a registry at a
  non-public address, set the registry origin in `oats-local.yaml`
  (`settings.oats.aweb.registry`). If DNS also names a non-default registry,
  the two must agree.

## Changed

- **OATS pins oats.aweb 1.49.1** (from 1.48.0; 1.49.0 and its patch):
  - support for aw 1.36.59: username setup resumes the signup aw kept after an
    unknown outcome, and aw retires a local member itself where this machine
    holds its team's controller key;
  - human attribution: the provider reads who stands behind a root or an
    identity (`aw who`) and shows it. Adopting a root on a hosted team is not
    open yet;
  - a home the kernel keeps after a retire no longer holds a usable aweb key;
  - `aw who` gets the configured registry;
  - retire keeps a home where a configured root reaches into it through a
    link, and on macOS paths that spell a home, the deployment or a root in
    another case are compared by their on-disk spelling (1.49.1).
