## Added

- **`oats host run`: the kernel's periodic work in one foreground process,
  for a host without a timer** (oats-project/oats#1789). Every `oats` command is
  short-lived, and the resume sweep and the schedule tick were started by a
  client or by a host timer. A container has neither, so nothing there
  resumes sessions after a restart, runs schedules, or stops the agents in
  order when the container stops. The command is what an operator, or the
  entrypoint of an image, runs for that; the agent image in
  `container/agent/` does not run it yet
  ([container.md](../container.md#the-kernels-periodic-work)).
  - `oats host run [--stop-grace <seconds>] [--plan] [--json]` runs the
    resume sweep once, then `oats schedule tick --host` at second 0 of every
    minute for the registered scopes, and lists the instances each minute so
    that the next start's sweep knows what ran. A minute whose tick still
    runs is skipped, and a missed minute is never replayed. With no scope
    registered it ticks nothing and says so.
  - On SIGTERM or SIGINT it stops ticking, waits for a tick that runs, then
    stops every running instance side by side: SIGTERM to the harness, a
    wait of `--stop-grace` seconds (default 20), never escalated. It exits
    0. The next start's sweep resumes those instances.
  - It refuses to start, before any effect, inside an instance session
    (`E_USAGE`), while the host timer is active (`E_HOST_RUN_TIMER_ACTIVE`),
    and while another `oats host run` holds this machine's lock
    (`E_HOST_RUN_BUSY`). Unit files that are installed and not active are a
    warning. The lock names its boot, so a lock left by a killed container
    is taken over by the next run.
  - `--plan` says what a run would refuse, the scopes it would tick and what
    its sweep would do, and changes nothing.
  - New contracts
    ([desktop-cli-api.md](../desktop-cli-api.md#the-host-run-oats-host-run)):
    the command and its flags; its answer, `{schemaVersion, plan, signal,
    warnings, sweep, ticks, stopped}`, and its plan, `{schemaVersion, plan,
    refusals, warnings, scopes, sweep}`; `E_HOST_RUN_BUSY` with
    `details.lock` and `details.found`; `E_HOST_RUN_TIMER_ACTIVE` with
    `details.unit`; `E_HOST_RUN_FAILED` for any other failure of the run.
- **`oats schedule host install --register-only`** records the deployment in
  the host schedule registry, with any caps given, and installs no timer
  (oats-project/oats#1789). It asks neither launchd nor systemd for
  anything, so it works in a container, where plain `host install` fails
  after registering. It does not go with `--print`. With `--server` it is
  sent only to a host that advertises the new feature
  `schedule-host-register-only` (and `schedule`); any other is refused here
  with `E_REMOTE_INCOMPATIBLE` before anything is sent, since a host that
  does not know the option ignores it and installs a timer. New contracts:
  the flag; its answer, which is `host install`'s; and the feature
  `schedule-host-register-only` in the probe
  ([schedules.md](../schedules.md#without-a-host-timer)).
- **A session that OATS stopped with the host is resumed**
  (oats-project/oats#1789). A stop by `oats host run` writes the home's stop
  record with `"resume": true` and `"reason": "host-stop"`, before the
  harness is signalled. Such a home reads `sessionEnd: "lost"`, whatever
  status its harness ended with; `sessionEnd` has no new value, and every
  other stop still reads `stopped`. `oats status` says `lost (stopped with
  the host)` under a local row. A new contract: `resume` and `reason` in
  `.oats-stop.json`
  ([execution-targets.md](../execution-targets.md#how-a-sessions-end-is-read)).
