## Added

- **Team image acceptance in CI.** Pull requests now build the team agent image
  from their exact head commit and run the existing container acceptance script
  on an amd64 runner with a private Compose fixture and no inference credentials.
  Release image publication is prepared after the OATS release, by digest with an
  exact release retention tag. The run and release notes record the immutable
  reference. Publication remains disabled pending the registry decision and
  requires a stable OATS release tag of at least 0.69.18 plus a committed final
  aw image pin of at least 1.36.59.
