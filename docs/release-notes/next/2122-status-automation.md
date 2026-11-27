## Added

- **An agent's row says which schedule or trigger made it** (#2122, KP-16).
  A home made by a schedule's or a trigger's run records `automation:
  {kind, id, qualifiedId}`, in `instance.json`, on the `spawned` event and
  on `oats status --json` rows; every other home reads `null`, and at most
  one of `automation` and `spawnedBy` is set. `oats server roster --json`
  relays it only from a host that lists the feature. It is a label, never
  proof: the automation names itself to its spawn with the internal flag
  `--made-by-automation`, recorded only for a schedule or trigger the
  deployment has, and no kernel decision reads it. Feature
  `status-automation`
  ([desktop-cli-api.md](../desktop-cli-api.md#made-by-an-automation)).
