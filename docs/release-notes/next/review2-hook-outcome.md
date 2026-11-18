## Fixed

- Consolidated the hook cleanup outcome rule across ordinary retire, spawn
  rollback and quarantine retry. The documented `nothing-to-delete` outcome
  remains the only complete cleanup that reports `retired: false`.
  Kernel lifecycle regressions also pin undocumented outcomes as incomplete.
