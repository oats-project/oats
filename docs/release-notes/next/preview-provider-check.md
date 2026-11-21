## Fixed

- **A preview on a session provider no longer reads clean for a launch the
  provider will refuse.** `oats spawn --preview` of a spawn on a session
  provider read complete, with no problem and no warning, and the spawn was
  then refused by the provider's readiness check and undone (with a provider
  that launches only in full mode and no full-mode choice:
  `E_BACKEND_SANDBOXED_MODE`). A preview now asks the provider's `check` with
  the launch that is planned, as the spawn does before any hook runs
  ([spawn preview](../desktop-cli-api.md), [check](../capabilities.md#check-optional)):
  - a launch the provider would refuse fails the preview with the spawn's own
    code and creates nothing; a provider that cannot be asked is
    `E_BACKEND_NOT_READY`; one that outlasts the preview's budget leaves
    `preflight.status: "timeout"`;
  - `oats launch-config preview --home` of a provider home asks it too, and
    shows a refusal as a failed `backend` item, with `ok: false`;
  - a provider in a member module, which runs only from a spawned home, is
    not asked: the preview says so in `warnings`.

  For a provider's author: `check` may now be handed a home that does not
  exist yet (a spawn's preview hands its planned path). It must only read,
  and treat an absent home as absent.
