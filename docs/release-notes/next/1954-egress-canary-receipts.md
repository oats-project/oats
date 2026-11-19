## Added

- The Compose egress boundary probe accepts `--json` for `{passed,receipts,error?}`
  output and an optional derived `namePrefix` for every temporary container.
  Receipts identify the name, image, network, confirmed creation and verified
  absence; stderr includes receipts and unverified names in either mode.

## Fixed

- Canary and TCP-control cleanup checks exact-name absence, including after Docker
  timeouts, and removes a container only when its per-attempt ownership label
  matches. Name collisions and failed observations refuse admission without
  removing another caller's container. Diagnostics distinguish confirmed leftovers
  from unowned or unverified names, including collisions. The host-side helpers remain outside the
  egress image build context.
