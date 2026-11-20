## Changed

- **oats.framework 1.28.0** (`oats.core` 2.16.0, `oats.coordination-setup`
  1.1.1, `oats.knowledge-theory` 1.1.3, `oats.onboarding` 1.3.1, `oats.setup`
  2.16.2).
  - `oats.core` adds `tui: "default"` to an agent's Claude settings when the
    key is absent, so Claude's fullscreen-renderer offer no longer takes a
    wake; a value already there stays (#1692). `/oats-operate` names the Node
    floor and doctor's `git-version:` line, from OATS 0.69.24.
  - `oats.coordination-setup` and `oats.onboarding` teach related work: a
    lead's children and its sibling leads, with `--related-work` from OATS
    0.69.23 (#2022).
  - `oats.knowledge-theory`'s proposal reference names `oats.okf` 6.3's
    division of work as an option (#2030).
  - `oats.setup`'s `oats-agent-permissions` skill explains why launch
    `args` are refused where a capability requires a harness package, and
    how to choose auto mode through the launch configuration's `env` (#1692).
  - Guidance text, plus the one `tui` default. Nothing changes for a
    deployment beyond `oats sync` taking the new tag; existing homes take
    oats.core 2.16.0 through `oats instance upgrade` or a new spawn.
