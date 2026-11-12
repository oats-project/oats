## Changed

- Release image preparation installs the exact kernel version just published,
  preserves unrelated committed lock entries and retains the generated inputs.
  Acceptance verifies the installed version before registry login. Publication
  remains disabled; its prepared path adds only the exact release retention tag,
  refuses tag conflicts and records an immutable digest receipt with explicit
  build/startup coverage and unrun agent and containment checks.
