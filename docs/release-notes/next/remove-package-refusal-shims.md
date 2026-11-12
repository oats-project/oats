## Removed

- **The 27 pre-workspace refusal exports in `lib/packages.mjs` are gone.**
  Their implementations were removed in 0.25.0; the 26 function shims and
  `REQUIREMENT_MANAGERS` proxy only threw `E_REMOVED`. Old named imports now
  fail at module loading; namespace imports no longer contain those names.
  Use workspace `packages:` plus `oats sync`; capability requirements and
  configuration belong to their provider, not the removed
  package-install/config-merge APIs. The same-named live APIs in
  `lib/resolve.mjs` (`lockedPackageCapabilities`) and `lib/core.mjs`
  (`packageSpecIdentity`) remain available. See the
  [package module contract](../design/2026-09-23-workspace-module-contracts.md#43-trust-and-removed-apis).
