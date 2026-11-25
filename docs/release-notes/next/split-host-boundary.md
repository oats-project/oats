## Added

- The egress boundary probe takes plan schema 2 for an agent host whose
  services run on another host. It proves, from the isolated agent and the
  proxy's outward bridge, that the one declared services-host address refuses
  TCP on the Redis port, and on the PostgreSQL port when PostgreSQL runs there.
  An external PostgreSQL at its own pinned address must be denied IP-wide by
  the policy and refuse the isolated agent; the outward bridge's result for it
  is recorded, not required, since the database's credentials protect it from
  other hosts. The `--json` document adds `mode:"split"`, the wrapper's `run`,
  the deploy copy's `sourceCommit` and the four role-by-vantage results, each
  naming the address it tested and whether it is required. A new services-host
  witness, `egress/probe-services-backends.mjs`, selects the Redis container,
  and the PostgreSQL container when it runs on the services host, by their
  Compose labels and proves them running, healthy, unpublished and reachable
  from their own networks; it does not attest an external PostgreSQL. It
  reports the Docker Engine version, since engines before 28.0.0 can allow direct
  routed access to unpublished container ports, and its refusals name the fix
  (a missing healthcheck, the number of matching containers found). Both run
  only from a deploy copy extracted from the egress image. `policy.mjs` exports
  `policyHash`, a canonical policy hash with a cross-language test vector. The
  proxy now records the hash of the policy it loaded at startup in
  `/tmp/egress/policy.hash`, and a split proof refuses with
  `E_EGRESS_POLICY_STALE` when the running proxy loaded a different policy
  than the plan: recreate the proxy after changing its policy. See
  the [run contract](../container.md#versioned-probe-and-live-lab-inputs) and
  the [split-host contract](../../container/agent/egress/README.md#split-agentservices-hosts).

## Upgrade

### What a deployment must change

- Nothing for schema-1 plans: their behaviour and JSON are unchanged. An
  unknown schema's refusal now names both versions:
  `E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found <x>; regenerate the plan with schema: 1 or schema: 2`.
  A wrapper that matches the old text must match the new one. Probes older than
  this release refuse a schema-2 plan with their schema-1 text.
