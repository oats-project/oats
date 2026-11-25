## Added

- The egress boundary probe takes plan schema 2 for an agent host whose
  services run on another host. It proves, from the isolated agent and the
  proxy's outward bridge, that the one declared services-host address refuses
  TCP on the PostgreSQL and Redis ports (an external PostgreSQL is checked at
  its own pinned, IP-wide denied address), and its `--json` document adds
  `mode:"split"`, the wrapper's `run`, the deploy copy's `sourceCommit` and the
  four role-by-vantage results, each naming the address it tested. A new services-host witness,
  `egress/probe-services-backends.mjs`, selects the PostgreSQL and Redis
  containers by their Compose labels and proves them running, healthy,
  unpublished and reachable from their own networks. Both run only from a
  deploy copy extracted from the egress image. `policy.mjs` exports
  `policyHash`, a canonical policy hash with a cross-language test vector. See
  the [run contract](../container.md#versioned-probe-and-live-lab-inputs) and
  the [split-host contract](../../container/agent/egress/README.md#split-agentservices-hosts).

## Upgrade

### What a deployment must change

- Nothing for schema-1 plans: their behaviour and JSON are unchanged. An
  unknown schema's refusal now names both versions:
  `E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found <x>; regenerate the plan with schema: 1 or schema: 2`.
  A wrapper that matches the old text must match the new one. Probes older than
  this release refuse a schema-2 plan with their schema-1 text.
