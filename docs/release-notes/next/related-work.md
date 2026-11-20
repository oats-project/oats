## Upgrade

- **The same-work flag is now the related-work flag, and the old spellings
  are refused.** `oats spawn … --same-work` answers `--same-work is renamed:
  use --related-work`, and `oats instance same-work …` answers `oats
  instance same-work is renamed: use oats instance related-work`. Both are
  `E_BAD_ARGS`, and nothing is done. Change skills and scripts to `oats spawn
  … --related-work` and `oats instance related-work <instance> on|off`.
- **An instance flagged before the upgrade reads off.** The kernel no longer
  reads `.oats-same-work.json`, so no row carries the flag until you set it
  again: `oats instance related-work <instance> on`. The old file is left in
  the home and is removed with it at retirement. To find the instances that
  had the flag, look for `.oats-same-work.json` in their homes.

## Changed

- **Related work, with a parent or a sibling** (feature
  `instance-related-work`, which replaces `instance-same-work`). The flag
  binds an instance's recorded parent, as before, and now also its recorded
  sibling when it has no parent. A top-level instance's sibling can carry it,
  so clients can draw a line between two siblings. A sibling binding names
  the sibling the home records: a sibling of a top-level R binds R, and a
  sibling of R's sibling S binds S. `--related-work`, and `oats instance
  related-work <instance> on`, on an instance that records neither a parent
  nor a sibling are refused with `E_BAD_ARGS`, naming why, and nothing is
  spawned or written. The flag reads off after a relink that changes the
  relation (a parent or a sibling retired), until `on` binds it again.
- `oats status --json` rows carry `relatedWork: true` in place of `sameWork:
  true`, and no row carries `sameWork`. The home file is
  `.oats-related-work.json`, `{"relatedWorkApi": 1, "parent" | "sibling":
  "<instance>", "at": "<ISO time>"}`. Both `.oats-related-work` and
  `.oats-same-work` are kernel-owned home names: a capability cannot declare
  either.
- **`--server`.** The roster relays `relatedWork: true`. A host on an older
  OATS, which advertises only `instance-same-work`, is sent the old spellings
  for an instance bound to its parent, and its rows' `sameWork: true` reach
  this machine as `relatedWork: true`. A sibling binding is refused there
  with `E_REMOTE_INCOMPATIBLE`, naming the host and the feature it lacks; it
  is never dropped. See
  [Related work](../desktop-cli-api.md#related-work-oats-instance-related-work).
