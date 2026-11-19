## Changed

- **`oats.framework` 1.26.0: `oats.core` 2.14.0, `oats.setup` 2.16.0,
  `oats.coordination-setup` 1.1.0.**
  - `oats.core`'s `/oats-operate` says that, from OATS 0.69.20, retiring a
    home whose recorded retire hooks cannot run is refused with
    `E_UNIDENTIFIED_INSTANCE_HOME` before anything stops, and that
    `oats retire <instance> --force` then removes the home, warning that the
    skipped hooks revoked nothing (#1953).
  - `oats.setup`'s `/oats-onboarding` pins `oats.okf` 6.2.0 for knowledge
    operations (#1945).
  - `oats.setup`'s `/oats-agent-permissions` example asks a person before
    `aw` runs with `--identity-home`, `--human` or `--team`, and no longer
    allows a bare `aw mail ack` (#1952).
  - `oats.coordination-setup` follows engineering-coordination template v4
    (#1943). A maintainer's green light is an option per lane, off by
    default. The landing rules list the lanes and their owners, and a lane's
    maintainer is found by its instance name, `<person>-<lane>-maintainer`.
    `VERIFIED at <head>` comes from whoever specified the work.

  No capability needs a newer OATS. The retire refusal is the kernel's own,
  and the skill names the version it starts in.
