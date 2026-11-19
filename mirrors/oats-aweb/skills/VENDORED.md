# Vendored aweb Agent Skills

These reviewed resources are vendored from the MIT-licensed aweb repository:

- Repository: <https://github.com/awebai/aweb.git>
- Upstream package: `@awebai/pi@0.2.3`
- Tag: `pi-v0.2.3`
- Commit: `812bdeb1be8ed99dbd339a910a153e7b802501d4`
- Registry integrity: `sha512-SnCT+5Ybh57G7+zwlfw6QRgAoyAVkyhcgRqIPPx47e+UcJdi5REXw9td806LveLEKAx0CwFTyxOInPH6mfs4EA==`
- License: MIT; see [`LICENSE`](LICENSE)

Vendored trees:

- /aweb-messaging (directory `skills/aweb-messaging/`, adapted for OATS: a sync rewrites its Pi channel line to say OATS installs `@awebai/pi`, filtering out its bundled skills below 0.5.0, and that a home's skills come from OATS, so `@awebai/claude-skills` is not installed in a pi folder that OATS homes use)
- /aweb-team-membership (directory `skills/aweb-team-membership/`, adapted for OATS: team changes go through `oats aweb teams|join|leave`)
- /aweb-identity (directory `skills/aweb-identity/`)

All three trees are adapted for OATS: they carry no task-coordination text, since this messaging capability never teaches it. A sync restores upstream's text; `test/no-task-coordination.test.mjs` fails until it is adapted again.

Not vendored: /oats-aweb (directory `skills/oats-aweb/`) is this package's own OATS playbook (identity,
default and joined teams, roster, delivery and wakes, etiquette,
troubleshooting). Every `aw` invocation it and the vendored skills cite is
checked against a real published aw by `test/oats-aweb-1-15.test.mjs`.

To update, check out the named upstream repository at the intended reviewed commit, update the constants in `scripts/sync-vendored-skills.mjs`, then run from this repository root:

```bash
node scripts/sync-vendored-skills.mjs --source /path/to/aweb
npm test
git diff -- oats-package/capabilities/oats-aweb/skills
```

The sync command refuses a checkout whose `HEAD` differs from its pinned commit. Review the complete generated diff, upstream license, and triggering descriptions before changing the recorded version/ref. Runtime acquisition never fetches these resources.
