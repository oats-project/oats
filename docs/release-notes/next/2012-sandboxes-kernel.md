## Upgrade

- **Add `sandboxes:` to a workspace only once every one of its hosts runs
  this release.** Every host reads the shared `oats-workspace.yaml`, so the
  commit that adds the block makes each host on an older kernel refuse the
  whole workspace (`E_WORKSPACE_SCHEMA`, with the "upgrade OATS" hint), not
  only the sandbox's host. Check first that `oats version --json` on each host
  lists `sandboxes` in `features`
  ([workspaces.md](../workspaces.md#sandboxes)).
- **A sandbox failure makes `oats sync` exit 1 with `ok: true`.** The lock is
  still written, and the failure is in the answer's `problems`; read the
  report whatever the exit. A deployment that lists no sandbox and started
  none answers exactly as before
  ([desktop-cli-api.md](../desktop-cli-api.md#oats-sync)).

## Added

- **Sandboxes in the kernel and the CLI** (feature `sandboxes`; the design
  record [2026-11-19-sandboxes](../design/2026-11-19-sandboxes.md)). The
  workspace declares `sandboxes: {<name>: {team, egress?, credentials?}}`; a
  soul whose default team is a sandbox's team runs inside it, on a host whose
  `oats-local.yaml` lists it under `sandboxes:`, and never on the host. A
  sandboxed team is only ever a soul's own default: a second sandbox, an
  alias, a default by pattern, a `teams:` list, `"any"` and a local team are
  refused or leave it out, compared by provider id
  ([workspaces.md](../workspaces.md#sandboxes),
  [configuration.md](../configuration.md#sandboxes)).
- **`oats sandbox status|start|stop|reconcile`**, through the one capability
  the defaults compose that declares the new `sandbox` hook event, with plans,
  idempotency keys and a per-sandbox lock; `oats sync` builds or starts each
  listed sandbox, stops one no longer listed (never destroys it) and
  reconciles their seats ([desktop-cli-api.md](../desktop-cli-api.md#sandboxes),
  [capabilities.md](../capabilities.md#the-sandbox-event)).
- **A spawn of a soul placed in a listed sandbox is routed into it**, with a
  seat the provider mints and delivers, bound to the preview's decision and
  keyed; the request is kept, 0600, until its seat settles, and replayed by
  the next reconcile when no answer came back. A retire from the host releases
  the seat. The kernel binds and keys that spawn itself: a spawn into a sandbox
  that brings its own `--expect-decision` or `--idempotency-key` is refused
  (`E_SANDBOX_PLACEMENT`, `caller-bound`), so the Desktop cannot spawn into a
  sandbox yet ([#2017](https://github.com/oats-project/oats/issues/2017));
  spawn with `oats spawn <soul>` or from a schedule.
- **A deployment that lists a sandbox runs no agent on the host**
  (`E_SANDBOX_HOST_AGENT`), and readiness reports the sandboxes' state in eight
  new items under `configured`. Server ids starting `sandbox-` are reserved
  (`E_SERVER_INVALID`, `reserved-prefix`).
- `placement: {sandbox, seatId}` on `oats status --json` rows of a home inside
  a sandbox; `capabilityMeta` on a spawn apply's answer;
  `OATS_SPAWN_IDEMPOTENCY_KEY` for a keyed apply's spawn hooks; feature
  `sandbox-egress-forge` for a sandbox's `forge` egress.
