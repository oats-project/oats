## Upgrade

- **What users must do: move to Node.js 22.5 or later.** OATS now stops before
  every command on Node below 22, including `version`, the reader and
  capability commands. If you run OATS on Node 20 today, upgrade Node before continuing.
  Node 18 and 20 receive `E_NODE_UNSUPPORTED` with exit 1, as one failure
  envelope on stdout with `--json`, or a message on stderr without it. Remote
  probes and Desktop discovery retain the host's refusal message. The npm
  package retains its Node 22.5.0 floor so installation warns about it.

## Added

- **Doctor reports Git's cache support.** Text and JSON doctor output name
  the Git version and whether it supports partial caches or uses the
  whole-tree fallback. This uses the existing `information[]` field, adds no
  warning and refuses nothing. Git 2.45 or later is recommended for partial
  caches; an older Git works with whole-tree fetches.

## Fixed

- **Claude agent panes skip the fullscreen-renderer offer.** At spawn and
  every launch, oats.core 2.16.0 adds `"tui": "default"` to a Claude home's
  `.claude/settings.json` if no `tui` key is present. Any existing value is
  kept. Agent panes use Claude's classic renderer even where Claude now
  defaults to fullscreen, and even over a user-level `"tui": "fullscreen"`;
  this keeps tmux scrollback and the renderer used by the launch-prompt
  captures. An existing project `tui` still wins. If oats.core stops adding
  the key, existing homes keep it until respawn. See
  [oats.core](../capabilities.md#oatscore-needs-input).

## Documentation

- **Launch args guidance matches the package-probe refusal.** Any non-empty
  launch-configuration `args` is refused at spawn with
  `E_LAUNCH_PROBE_UNSUPPORTED` while an active capability requires a package
  for that harness; with oats.aweb, every Claude launch has such a requirement.
  `claude plugin list --json` cannot carry those args, and `--settings` can
  change which plugins load. The supported routes are user `settings.json`
  in the Claude config selected by `CLAUDE_CONFIG_DIR` through `env`, which
  the probe carries, or a wrapper executable. `/oats-agent-permissions` now
  teaches `permissions.defaultMode: "auto"` in that user file, replacing its
  launch-args advice. See [launch configurations](../configuration.md#launch-configurations).
