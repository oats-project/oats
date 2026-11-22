## Added

- **OATS reports a harness that runs in a provider home an operator stopped**
  (feature `provider-outside-oats`). A session provider's own product can
  start a stopped session's harness again without OATS, for example when a
  person types a message there. `oats status` now asks the provider about
  its stopped homes in the `inspectMany` call it already makes for the
  running ones of their group (one call for the provider where none of its
  homes runs, after every running home was asked), and the row of a home
  whose provider answers a live harness carries `outsideOats: {code:
  "running-outside-oats", backend, message}` in `--json`, and the message on
  a line under the row in text; `oats server roster` relays it in that exact
  shape. The key is a report and nothing else: the row stays `running:
  false`, `runtimeState: "stopped"`, an input to the home stays refused, the
  sweep never resumes an operator's stop, and the read writes nothing. A
  provider that fails or does not answer leaves the row stopped, without the
  key. The message names the remedy: `oats instance stop <name>`, or a start
  from OATS ([desktop-cli-api.md](../desktop-cli-api.md#row-outside-oats)).
- **A session provider is told which stop the host's shutdown is.** The
  `stop` input of `oats host run`'s shutdown carries `reason: "host"`, as
  does the stop that follows a failed resume notice of such a home, and no
  other stop carries a `reason`, so a provider that archives what it stops
  can keep that session for the resume's input. The key is optional and the
  wire version is unchanged ([capabilities.md](../capabilities.md#stop)).

## Changed

- **A provider home stopped with the host whose harness runs again is
  adopted, not resumed.** When a person's message reached its session before
  the sweep, or the harness came back, `oats status` reads the home running
  from the provider's answer, and the sweep clears the stop without sending
  its resume notice into the running harness; nothing is counted, and the
  sweep's row is `already-running`. `oats session start --resume` of such a
  home does the same and answers `E_SESSION_RUNNING`. The resume of a home
  stopped with the host now asks the provider's `inspect` before its notice.
- **`oats instance upgrade` refuses a provider home recorded stopped whose
  harness runs** (`E_SESSION_RUNNING`, naming `oats instance stop <name>`),
  at the plan and at the apply: it asks the provider once, and never upgrades
  under a running harness. An upgrade whose provider cannot be asked goes on,
  since the home is as OATS recorded it.
- **A session provider's `inspectMany` now receives the homes OATS stopped**,
  with the endpoint of their last session, beside the running ones. `oats
  status` still never calls `inspect` for a stopped home, and never reads a
  home an operator stopped as running
  ([capabilities.md](../capabilities.md#inspect-and-inspectmany)).
