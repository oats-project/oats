## Upgrade

- **OATS pins oats.aweb 1.49.2** (from 1.49.1). Its floor stays OATS 0.70.0.
  Running instances keep the module they were spawned with: respawn them, or
  move a stopped one with `oats instance upgrade`, to take 1.49.2. Nothing
  else changes for a deployment.

## Fixed

- **Under session delivery, an idle agent is no longer published as
  degraded** (oats.aweb 1.49.2, awebai/oats-aweb#332). The host wake broker
  records its inspection of a session only at startup and before a delivery,
  so an idle home's recorded inspection aged into `degraded`
  (`oats.receive_unproven`) without any fault. Readiness now gives that age
  its own warning, `receive-inspection-aged`, which the status publisher does
  not count against a home its own inspection found alive. A stale broker
  snapshot (`receive-observation-aged`) and every broken precondition still
  read with their own reason.
