## Upgrade

- **Anyone routing to an execution host older than OATS 0.69.15 must upgrade
  that host first:** run `npm install -g @awebai/oats@latest` on the host.
  The router refuses every routed command except `status` against older hosts
  with `E_REMOTE_INCOMPATIBLE`, including retire, session, schedule and operations.
  A host at or above that version must also advertise `spawn-task-stdin`,
  `spawn-preview-2`, `spawn-apply-2` and `spawn-idempotency-2`.

## Removed

- **Routed spawns no longer fall back to task text on argv or an unbound
  apply.** Tasks travel on ssh standard input to both preview and apply;
  a plain spawn is bound to its preview and a retry key. A host missing the
  required features is refused with an upgrade command before any spawn,
  including a preview or an apply with the caller's own decision and key.
