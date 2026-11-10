- `oats server add` and `oats server connect` accept `--operator-ssh <alias>`.
  The optional `operatorSshHost` registration field follows the same validation
  rules as `sshHost` and appears in `server list`. This records a route for
  credential provisioning; existing commands and saved instance routes keep
  using the agent's SSH alias.
