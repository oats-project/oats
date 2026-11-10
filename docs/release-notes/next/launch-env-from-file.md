- Launch configuration environment values accept `{ fromFile: /absolute/path }`.
  Each start reads a regular UTF-8 file on its execution host and removes one
  trailing line ending, preserving a UTF-8 BOM. Invalid UTF-8, missing,
  unreadable, NUL-containing or nonregular files
  refuse with `E_LAUNCH_ENV_MISSING` and a provisioning remedy. Preview, list
  and recipes contain references only; resume checks compare keyed digests.
- Both `fromEnv` and `fromFile` values now reach the pane through a private
  per-start file, removed by the launcher before the harness runs. This removes
  the existing `fromEnv` exposure in tmux process arguments. A subsequent start
  removes abandoned handoff files, including when it needs no references.
