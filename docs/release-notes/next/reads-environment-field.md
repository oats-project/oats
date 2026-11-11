## Changed

- **The capability manifest accepts `readsEnvironment`.** A package author
  can now say what a capability's module commands read from the environment
  of whoever runs them outside a launch (a readiness check,
  `oats operation run`): a list of exact variable names and of prefixes
  ending in an underscore, such as `["AW_", "CLAUDE_CONFIG_DIR"]`. It grants
  no right to set anything; `environment` and `environmentNamespaces` are
  unchanged. Entries under `OATS_`, `OAS_` and `PI_`, a bare `_`, and a
  prefix with fewer than two characters before its underscore are refused by
  name. `[]` says the commands read none
  ([capabilities](../capabilities.md#manifest)).

  This release only accepts the field: nothing is filtered yet. A later
  release gives those commands a fixed base environment plus what the
  manifest declares, and warns for a capability that declares nothing. A
  package that declares the field must raise its `compatibility.oats` floor
  to this release, because an earlier kernel's schema refuses it.
