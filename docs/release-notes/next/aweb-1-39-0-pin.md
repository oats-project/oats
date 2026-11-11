## Upgrade

- **oats.aweb 1.39.0 tests aw 1.36.56** (from 1.36.53). The floor stays
  aw 1.36.33. `aw-newer-than-tested` now warns only above 1.36.56, and the
  pin it names is `npm i -g @awebai/aw@1.36.56`. Install that version on
  each host where readiness asks for it.
- **pi homes: remove or filter `@awebai/claude-skills` in the launch's pi
  folder.** From oats.aweb 1.38.0, home readiness warns
  `pi-skills-package-loaded` when that pi folder lists
  `npm:@awebai/claude-skills` without `"skills": []`. Remove the entry, or
  filter it. With @awebai/pi 0.5.0 or later installed there,
  `pi-extension-skills-loaded` no longer asks for the skills filter.
- **Bringing your own team** (`oats aweb setup --create <label> --namespace
  <domain>`) needs aw 1.36.53 or later, and refuses an older aw before it
  creates anything.

## Changed

- **The official catalog pins oats.aweb 1.39.0** (from 1.37.0, crossing
  1.38.0), and OATS's own workspace takes it. It brings:
  - from 1.38.0, the pi skills-filter change above;
  - from 1.39.0, a bring-your-own-team create that runs to the end
    (registers the team, publishes and verifies its team-server record, and
    resumes when re-run); a public `aw-compat.json` stating the aw floor and
    the tested aw; and owner-only draft files for mail and chat bodies
    instead of fixed `/tmp` paths.

  `mirrors/oats-aweb` and `mirrors/oats-aweb-tasks` are copied from the
  v1.39.0 tag
  ([oats.aweb's CHANGELOG](https://github.com/awebai/oats-aweb/blob/v1.39.0/CHANGELOG.md)).
