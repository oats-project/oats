## Changed

- **Release workflow permissions.** Test and build jobs now run with
  read-only repository access. Only the `publish` job can write the release
  and bump PR; the disabled team-image publication job retains its separate
  repository and package write permissions.
