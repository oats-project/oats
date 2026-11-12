## Changed

- The unshipped standalone agent chart becomes an `oats-team-agent` library
  component for the canonical aweb team deployment root. It reads normalized
  root `agents` and `egress` sections, without component defaults or a second
  schema. The root supplies the existing wrapper's public
  `generated/egress-policy.json` artifact; Kubernetes uses the same egress image
  and policy as Compose. Agent DNS and egress policy are mandatory, supervisor
  liveness is distinct from SSH readiness, and the original resource,
  persistence and security restrictions remain.
- `accept-kube.sh --chart PATH` checks the actual agent component inside the
  installable root render. See the [library input and artifact contract](../../container/agent/chart/README.md).
  The former standalone chart has not shipped; #1883 remains native FAIL and held.
  This change publishes no chart or image and makes no CNI enforcement claim.
- Optional `agents.caFile` uses root `generated/agent-ca.pem`, a public-only
  ConfigMap projection at mode 0444, and exactly the two fixed trust settings
  before container startup. Admission rejects unexpected trust data, mounts,
  environment settings and TLS bypasses; native trust proof remains separate.
