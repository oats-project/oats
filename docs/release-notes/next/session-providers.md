## Added

- **Session providers: a capability can supply a session backend** (feature
  `session-providers`). tmux stays the kernel's own backend and the default,
  and tmux homes are unchanged. A capability declares `sessionProviders` in
  its manifest, four of its own commands (`launch`, `inspect`, `input`,
  `stop`, and optionally `inspectMany` and `check`), and `oats spawn <soul>
  --backend <name>` (a schedule's `backend`, a trigger's `spawn.backend`)
  runs the instance there. OATS keeps the home, the records, the lifecycle
  and the answers.
  - A provider home records `backend` and `session: {provider, endpoint}`.
    Its status row carries `backend`, `session: {provider}` and `open` (a
    link to show instead of a terminal), and on its own host the endpoint's
    thread id; the endpoint is on its local inspect, spawn and start answers
    only, and nothing of it is relayed to another machine. `oats inspect` and
    `oats capabilities show` list `sessionProviders`.
  - A spawn holds its new home's lifecycle claim while the provider
    launches, and the home's receipt records that a launch was sent until
    its outcome is recorded (`runtime.launchSent`): a spawn or a start
    killed mid-launch leaves a home that reads as unknown, whose next stop,
    start or retire first asks the provider to stop what it started.
  - A stop made with OATS stays stopped: inspect answers stopped and every
    input is refused `E_SESSION_NOT_RUNNING` until the home is started,
    without asking the provider.
  - Only a lost session is resumed, in its own conversation: one stopped by
    `oats host run`'s shutdown, or one that is gone while OATS did not stop
    it. `oats session resume` sends it one notice through the provider's
    input, under a cap of 3 resumes of one home in an hour; any input to a
    lost session counts as one.
  - A provider's readiness (`check`) is asked right before every launch
    (`E_BACKEND_NOT_READY`), and `oats readiness` relays it.
  - New codes: `E_BACKEND_UNKNOWN`, `E_BACKEND_AMBIGUOUS`,
    `E_BACKEND_HARNESS`, `E_BACKEND_LAUNCH_ARG`, `E_BACKEND_NOT_READY`,
    `E_SESSION_NO_TERMINAL` (attach), `E_SESSION_PROMPT_OPEN` and
    `E_SESSION_INPUT_QUEUED` (input).
  - A routed `--backend <provider>` is sent only to a host that lists the
    feature. A kernel without it that meets a provider home only refuses.

  See [Session providers](../execution-targets.md#session-providers) and, for
  a capability's author,
  [Session providers (`sessionProviders`)](../capabilities.md#session-providers-sessionproviders).
- **A harness-package requirement can name its backends.** A `requires` row
  of a capability manifest takes `backends: ["tmux"]`, `["session-provider"]`
  or both; without it the row applies to every launch. A kernel without
  `session-providers` applies such a row to every launch, so a package that
  uses the key raises its OATS floor.

## Changed

- **Capability hooks get `OATS_BACKEND`.** Every spawn hook and launch hook
  is given the session backend the instance launches on: `tmux`, or a session
  provider's name.
- **A tmux home's row of `oats status --json` carries `backend: "tmux"`.** A
  row with no `backend` key comes from a kernel without `session-providers`,
  and reads as a tmux home's.
