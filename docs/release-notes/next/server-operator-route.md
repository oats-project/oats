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
