## Fixed

- Every official package mirror is now generated from its catalog-pinned Git
  tag and checked for complete file sets, bytes, executable modes and symlink
  targets in pull-request CI. Workspace and current documentation/skill pins
  are checked against the catalog; the packed-artifact smoke reads its pins
  from the same source. See [the mirror procedure](../official-catalog.md#updating-the-test-mirrors).
