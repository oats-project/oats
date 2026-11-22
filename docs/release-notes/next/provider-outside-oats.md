## Added

- **OATS reports a harness that runs in a provider home it recorded stopped**
  (feature `provider-outside-oats`). A session provider's own product can
  start a stopped session's harness again without OATS, for example when a
  person types a message there. `oats status --json` now asks the provider
  about its stopped homes in the `inspectMany` call it already makes for its
  running ones (one call of their own where none runs), and the row of a home
  whose provider answers a live harness carries `outsideOats: {code:
  "running-outside-oats", backend, message}`; `oats server roster` relays it
  in that exact shape. The key is a report and nothing else: the row stays
  `running: false`, `runtimeState: "stopped"`, an input to the home stays
  refused, the sweep never resumes an operator's stop, and the read writes
  nothing. A provider that fails or does not answer leaves the row stopped,
  without the key. The message names the remedy: `oats instance stop <name>`,
  or a start from OATS
  ([desktop-cli-api.md](../desktop-cli-api.md#row-outside-oats)).

## Changed

- **`oats instance upgrade` refuses a provider home recorded stopped whose
  harness runs** (`E_SESSION_RUNNING`, naming `oats instance stop <name>`),
  at the plan and at the apply: it asks the provider once, and never upgrades
  under a running harness. A provider that cannot be asked leaves the home
  as OATS recorded it.
- **A session provider's `inspectMany` now receives the homes OATS stopped**,
  with the endpoint of their last session, beside the running ones. The
  kernel still never calls `inspect` for a stopped home from `oats status`
  and never reads one as running
  ([capabilities.md](../capabilities.md#inspect-and-inspectmany)).
