## Added

- Agent egress policies can declare a nonempty subset of aweb, logs, registry,
  secrets and signer. Targets and probe paths must match exactly; signer-only
  authority and human-origin fields are refused without signer. Omission keeps
  the existing five-service compilation. The minimal Compose wrapper includes
  explicit IPAM and a read-only preflight that refuses failed observations and
  overlaps. Every subset retains the universal boundary controls; team-image CI
  builds and probes the full set and two messaging subsets. See the
  [container reference](../container.md#egress-component).
