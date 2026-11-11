## Upgrade

- **oats.aweb 1.39.1 tests aw 1.36.58** (from 1.36.56); the floor stays
  aw 1.36.33. `aw-newer-than-tested` now warns only above 1.36.58, and
  `oats aweb setup --create --namespace` names and, with `--install-aw`,
  installs aw 1.36.58. Install that version on each host where readiness
  asks for it.
- **Stop an older wake broker before the new aw's starts.** aw 1.36.58's
  broker takes an OS file lock that an earlier broker doesn't hold. Rerun
  `oats aweb wake install` after the aw upgrade: it restarts the unit. A
  broker started by hand is stopped by hand first.

## Changed

- **The official catalog pins oats.aweb 1.39.1** (from 1.39.0), with its
  mirrors. With aw 1.36.58, a wake stream the server refused shows as
  `refused` and is retried; readiness reports it as `wake-stream-unavailable`,
  as before, without naming the phase yet.
