## Added

- The team image accepts one explicit `AWID_REGISTRY_URL` HTTPS origin from the
  bundle's `team.registryUrl`. Startup validates it before any child starts,
  passes it to the broker, and writes private runtime data for the immutable
  SSH/login profile to revalidate without evaluating shell code. Unset input
  clears stale data; invalid or unreadable present data keeps the shell open
  with an explicit invalid selector rather than selecting aw's default.
- Exact acceptance checks the registry environment and runtime snapshot. The
  boundary probe expects the registry origin from its existing derived policy.
  The bundle must render that value into the agent, inert probe and explicit
  harness launch environment. Agents sharing the UID can replace runtime data
  or set their own environment; no new egress origin or verification bypass is
  added.
