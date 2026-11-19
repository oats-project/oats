## Added

- **The `oats-getting-started` skill sets up a new workspace on the
  person's own aweb server** (#1774, #1775). Step 1's messaging line names
  hosted aweb as the default, "unless you run your own aweb server". The
  own-server answer collects
  three things, none of them secret: the namespace domain the person
  controls, the server's public URL, and whether the server uses the public
  AWID registry. A server on a private registry is not set up yet: the
  branch stops before writing anything, says it needs `oats.aweb` with
  `oats aweb setup --registry` (awebai/oats-aweb#284), and offers hosted
  aweb. It also names the prerequisites, which stay on the person's side:
  the namespace's controller key on this computer, its `_awid` DNS record,
  and the server reachable. Then:
  - The skill installs `aw` at the version `oats.aweb` was tested with
    (`tested` in its `aw-compat.json`, read at the catalog's exact
    `oats.aweb` ref, never `main`). It checks the version `aw` prints, and
    that the program `file` reports is for this machine's architecture. On
    an OATS release whose `oats.aweb` is older than `v1.42.1`, the branch
    stops and offers hosted aweb.
  - The workspace commits the team `<workspace>:<namespace>` as its only
    team and its default. It writes no hosted `default:…aweb.ai` team and no
    `localTeams`.
  - Step 9 checks the DNS record read-only
    (`aw id namespace check-txt`), then creates the team with
    `oats aweb setup --create <workspace> --namespace <domain> --name <workspace>-root`,
    registered with the person's server. It reports where the team key
    lives (the path, never the key), and checks membership before the
    spawn.

  The skill never makes the namespace's controller key, and never asks for
  `AWEB_API_KEY`. Hosted aweb is unchanged: it installs the latest `aw` and
  records its version. The join of an existing workspace and the machine
  found-list are unchanged, and don't offer the own-server branch.
