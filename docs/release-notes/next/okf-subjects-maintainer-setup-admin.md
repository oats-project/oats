## Upgrade

- **Respawn an instance of `oats-maintainer` or `oats-setup-admin` once**
  after `oats sync`. An instance keeps the `okf.json` its spawn recorded, so
  one started before this release still reads and proposes to its old node; a
  new spawn reads the soul's subjects. The soul needs a knowledge base bound
  with the subject layout: on a base that is not bridged, its spawn refuses
  with `E_CONFIG` naming the base
  ([okf.json version 2](../knowledge.md#the-souls-okfjson)).

## Changed

- **`oats-maintainer` and `oats-setup-admin` read by subject** (`okf.json`
  version 2). The maintainer's subjects are `workstream/oats-direction`,
  `workstream/coordination`, `system/oats-kernel`, `system/oats-desktop`,
  `workstream/provider-integration`, `workstream/operations`,
  `workstream/positioning` and `workstream/workspace-administration`: the
  subjects that absorb the nodes it owned and read. The setup admin's are
  `workstream/workspace-administration`, `workstream/operations`,
  `workstream/oats-direction`, `workstream/coordination` and
  `system/oats-kernel`. Their texts say each proposed claim names the subjects
  it is about.
