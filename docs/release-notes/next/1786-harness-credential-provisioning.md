## Added

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
- `fromFile` is for credential values. Directory selectors require a literal
  or `{ fromEnv: NAME }`; validation names the selector and remedy.
- With references, the private handoff runs the pane wrapper through `/bin/sh`.
  Harness arguments already pass through the native recorder's POSIX shell;
  capability launch contributions are parsed arguments, not shell programs.
- File sources are capped at 64 KiB, including a final newline, with bounded
  reads. Refusals name the file and the missing, type, permission, encoding, NUL
  or size problem while keeping `E_LAUNCH_ENV_MISSING`.

- Claude starts check the effective configuration directory for a `/login`
  credential. When OATS also sets `CLAUDE_CODE_OAUTH_TOKEN` (literal, `fromEnv`,
  `fromFile` or a launch hook), the start refuses with
  `E_CLAUDE_LOGIN_CREDENTIAL`, naming the exact credential file and
  `oats harness token set claude`. Without an OATS-set token, a personal
  `/login` credential is allowed silently. Remove the `/login` credential before
  starting on the token route. Inherited pane tokens do not trigger refusal.
- Spawn preview and apply check the predictable launch configuration before
  creating a home, worktree or identity.
  Hook-supplied selectors and tokens are checked once their environment is
  known, and the actual pane is checked again before dispatch.
- The final credential check follows the harness selected for this start,
  including a switch between Claude and another harness. Hook-supplied
  directory selectors are covered at preview, spawn and start.

- `oats server add` and `oats server connect` accept `--operator-ssh <alias>`.
  The optional operator route follows the same validation rules as `sshHost`
  and appears as `operatorSshHost` in `server list` and connect's registration.
  It lives in `~/.oats/server-operator-routes.json`, under the same servers
  lock, so `servers.json` stays readable by older kernels, including Desktop's
  bundled kernel. Older kernels never read the separate file.
- `--replace` keeps the operator route unless `--operator-ssh` sets it again
  or `--no-operator-ssh` clears it. `server remove` deletes its route too.
  Existing commands and saved instance targets keep using the agent's SSH alias.
- A fresh registration never inherits an orphan operator route left by an
  older kernel's remove. On an unchanged agent target, an operator-only update
  preserves `servers.json` bytes; an answered `--replace` can still refresh a
  stale workspace key without a false concurrency warning.
