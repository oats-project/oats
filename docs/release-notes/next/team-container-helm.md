## Added

- A Helm 3 chart for one persistent team agent container, with explicit pod
  security, admission-budget defaults, optional forwarder DNS and egress
  policy, and a kubectl acceptance script for rendered and admitted settings,
  SSH access and a disposable-pod shutdown proof. NetworkPolicy enforcement
  is not assumed. See [Team agent containers](../container.md#kubernetes).
