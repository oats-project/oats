- `oats server add` and `oats server connect` accept `--operator-ssh <alias>`.
  The optional `operatorSshHost` registration field follows the same validation
  rules as `sshHost` and appears in `server list`. This records a route for
  credential provisioning; existing commands and saved instance routes keep
  using the agent's SSH alias.
- Before using an older kernel (including Desktop's bundled kernel), remove
  `operatorSshHost` from every entry in `~/.oats/servers.json`. Older kernels
  reject the unknown field and refuse the whole registry; they do not ignore it.
