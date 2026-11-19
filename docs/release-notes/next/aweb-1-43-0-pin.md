## Changed

- **The catalog pins oats.aweb 1.43.0** (awebai/oats-aweb, tag `v1.43.0`), up
  from 1.42.1. It still requires OATS >=0.68.0; the aw floor stays 1.36.33 and
  the tested aw 1.36.58.
  - **Registry admission is one host setting.** A private aw registry is
    admitted only by `settings.oats.aweb.registry`, which
    `oats aweb setup --registry <origin>` records in `oats-local.yaml`. A saved
    `registry_url` and an exported `AWID_REGISTRY_URL` are locators only.
  - **aw children ignore exported selectors.** Each takes only what a call
    passes by name. A malformed `OATS_SETTINGS` refuses instead of using
    defaults.
  - **A grant seat's calls stay in its recorded team,** and its
    `.oats-aweb/seat.json` owns that team. An empty grant seat now completes
    retire with the documented `nothing-to-delete` outcome.
  - **Membership and custody reads fail closed.** An unreadable read is
    unknown, never "not a member".
  - **Setup** names an unavailable username, and points a new account at
    `claim-human`. `--invite-stdin` reads the token without echo on a
    terminal, and `oats aweb invite --out <file>` writes it to a new
    owner-only file.

## Upgrade

What a deployment must change, from oats.aweb's 1.43.0 entry:

- **On a non-public aw registry:**
  1. Run `oats aweb setup --registry <origin>` in the deployment.
  2. Rerun `oats aweb resident create <name>` for each resident.
  3. Run `oats aweb wake install` from your own shell.
  4. Restart the homes.

  Until then, setup, spawn, join, launch and readiness refuse with
  `registry-setting-required`. A deployment on the public registry changes
  nothing.
- **Exported aw selectors no longer reach aw:** `AWEB_IDENTITY_HOME`,
  `AWEB_URL`, `AWEB_API_KEY`, `AWEB_ROLE_NAME`, `AWEB_ROLE`,
  `AWID_REGISTRY_URL`. If you exported them for ordinary lifecycle commands,
  record the service in the selected aw home instead, and a private registry
  in the setting above.
- **Grant seats:**
  - A grant seat with `.oats-aweb/seat.json` whose `identity.resident` or
    default team has changed refuses start: respawn it.
  - A home that an earlier release renewed into another team needs the
    printed manual revoke, then `oats retire <instance> --force`.
- **Retained seats:** a symlinked `identity.source`, or a link or special
  file in the copied authority, now refuses. Point it at the real directory.
- **Scripts:**
  - `oats aweb setup --check-only --json` answers `member:null` with a nonzero
    exit when the membership can't be read.
  - `join --plan` fails with `E_SETUP_MEMBERSHIP` for an unreadable root.
  - `setup --create`, and `setup --join` without a token, refuse while the
    default root's membership can't be read.
  - An unavailable username fails as `E_SETUP_USERNAME_UNAVAILABLE`, where it
    was `E_SETUP_NATIVE`.

Respawn instances to take the new oats.aweb module, or move a stopped home
with `oats instance upgrade`.
