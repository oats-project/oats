## Upgrade

- **Respawn an instance of `oats-engineering-expert` or `oats-product-expert`
  once** after `oats sync`. An instance keeps the `okf.json` its spawn
  recorded, so one started before this release still reads and proposes to
  its old node; a new spawn reads the soul's subjects. The soul needs a
  knowledge base bound with the subject layout: on a base that is not
  bridged, its spawn refuses with `E_CONFIG` naming the base
  ([okf.json version 2](../knowledge.md#the-souls-okfjson)).

## Changed

- **`oats-engineering-expert` and `oats-product-expert` read by subject**
  (`okf.json` version 2). The engineering expert's subjects are
  `system/oats-kernel`, `system/oats-desktop`,
  `workstream/provider-integration`, `workstream/operations` and
  `workstream/coordination`; the product expert's are
  `workstream/oats-direction` and `workstream/positioning`. Their spawn brief
  lists those subjects, and their texts say each proposed claim names the
  subjects it is about. Every other soul keeps its version-1 `okf.json`.
