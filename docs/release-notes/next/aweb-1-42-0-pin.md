## Changed

- **The catalog pins oats.aweb 1.42.0** (from 1.41.0). It requires OATS
  >=0.68.0, the aw floor stays 1.36.33, and the tested aw is 1.36.58. Most of
  the release is about retained seats: an atomic seat lock, a lock held on
  another host refuses with its release, a killed or failed spawn never
  deletes the standing identity's workspace, and a seat with no membership of
  its team is refused before any effect. The captured-execution variables are
  now ignored, with one warning each. The always-loaded messaging
  instructions are shorter, and new spawns get the new text.

## Upgrade

- **A retained seat reads its aweb service only from its own record.** If
  you set `OATS_AWEB_URL` for a retained seat, record the server in the seat
  with `aw workspace connect --service <server>`, run in the seat's parent
  directory, then unset the variable. A seat whose `workspace.yaml` already
  names its server is unchanged.
- **A non-boolean `identity.e2ee` or `identity.takeOver` is refused** at spawn
  and start. `true`, `false` and the strings `"true"`/`"false"` are accepted,
  and an empty value reads as unset. Set any other value to `true` or `false`.
