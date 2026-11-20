## Upgrade

- **The same-work flag is now the related-work flag; the old spellings
  still work.** `oats spawn … --same-work` and `oats instance same-work …`
  are deprecated aliases of `oats spawn … --related-work` and `oats instance
  related-work <instance> on|off`, with the same binding. Each use prints one
  line on stderr (`--same-work is renamed: use --related-work`, `oats
  instance same-work is renamed: use oats instance related-work`); `--json`
  output is unchanged. Instances flagged before the upgrade keep their flag.
  Move skills and scripts to `--related-work` once every host they run
  against is on this release; the aliases stay until their removal is
  decided, with its own release-notes entry.

## Changed

- **Related work, with a parent or a sibling** (feature
  `instance-related-work`; `instance-same-work` is still advertised beside
  it). The flag binds an instance's recorded parent, as before, and now also
  its recorded sibling when it has no parent. A top-level instance's sibling
  can carry it, so clients can draw a line between two siblings. A sibling
  binding names the sibling the home records: a sibling of a top-level R
  binds R, and a sibling of R's sibling S binds S. `--related-work`, and
  `oats instance related-work <instance> on`, on an instance that records
  neither a parent nor a sibling are refused with `E_BAD_ARGS`, naming why,
  and nothing is spawned or written. The flag reads off after a relink that
  changes the relation (a parent or a sibling retired), until `on` binds it
  again.
- `oats status --json` rows carry `relatedWork: true`, and `sameWork: true`
  beside it when the flag is bound to the parent (never for a sibling). The
  verb answers `{"instance", "relatedWork", "sameWork"}`. The home file is
  `.oats-related-work.json`, `{"relatedWorkApi": 1, "parent" | "sibling":
  "<instance>", "at": "<ISO time>"}`. An existing `.oats-same-work.json`
  still reads as a parent binding while the new file is absent; the first
  write of the new file removes it, and `off` removes both. Both
  `.oats-related-work` and `.oats-same-work` are kernel-owned home names: a
  capability cannot declare either.
- **`--server`.** The roster and `oats status --server --json` relay
  `relatedWork: true`, and `sameWork: true` beside it for a parent binding.
  A host on an older OATS, which advertises only `instance-same-work`, is
  sent the old spellings for an instance bound to its parent, and its rows'
  `sameWork: true` reach this machine with `relatedWork: true` beside it. A
  sibling binding is refused there with `E_REMOTE_INCOMPATIBLE`, naming the
  host and the feature it lacks; it is never dropped. See
  [Related work](../desktop-cli-api.md#related-work-oats-instance-related-work).
