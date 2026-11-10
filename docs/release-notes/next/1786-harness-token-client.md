## Added

- `oats harness token status|remove <harness> --server <id>` uses the
  registration's separate operator SSH route and forced-command credential
  receiver. It never falls back to the agent alias or reuses its connection.
  Results contain only the fingerprint, replacement time and identifying
  metadata. The team name is explicit or a valid server label.
