## Upgrade

- After pulling the updated team agent image, recreate existing agent containers
  to apply the 50-second stop timeout. Acceptance refuses the previous 45-second
  timeout.
