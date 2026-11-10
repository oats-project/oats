## Added

- `oats harness token set|status|remove <harness> --server <id>` uses the
  separate operator SSH route and forced-command credential receiver.
  `set --stdin` supports Claude setup-tokens and Codex, pi and opencode
  API keys, without credential arguments, output or client files. A missing
  operator route refuses; it never falls back to the agent route or reuses
  its authenticated connection.
- Rotation lists sessions of the same harness started before replacement;
  they pick up the new value at their next start. Nothing restarts
  automatically. A roster failure after installation is a warning, not a
  failed install. Claude interactive capture is unavailable, and refreshing
  browser sign-ins do not fit the read-only credential model.
