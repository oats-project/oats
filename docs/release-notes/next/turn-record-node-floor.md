## Upgrade

- **The package names the turn record's Node requirement.** `engines.node`
  is now `"^22.13.0 || >=23.4.0"`: Node 22.13+ on 22.x, 23.4+ on 23.x,
  or a newer major. npm now warns at install on Node 22.0–22.12 and
  23.0–23.3, where the turn record cannot load `node:sqlite` without an
  experimental flag. The CLI still runs on those versions; its
  `E_NODE_UNSUPPORTED` refusal remains only for Node below 22.

## Fixed

- **A missing SQLite module names the fix.** When the turn record cannot
  load `node:sqlite`, it reports the Node version it needs and the version
  running, keeping the original error as its cause.
