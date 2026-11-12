## Added

- **Team image acceptance in CI.** Pull requests now build the team agent image
  from their exact head commit and run the existing container acceptance script
  on an amd64 runner with a private Compose fixture and no inference credentials.
  Release image publication is prepared after the OATS release, by digest only
  with the run and release notes recording the immutable reference. Publication
  remains disabled pending the registry decision and requires final OATS 0.69.18+
  and aw 1.36.59+ image pins.
