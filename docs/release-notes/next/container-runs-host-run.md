## Upgrade

- **Rebuild the [team agent image](../container.md) and recreate its
  container.** The image pins OATS 0.69.15 and its entrypoint runs
  `oats host run`; an existing container keeps the old entrypoint, the
  10-second stop timeout and no healthcheck until it is made again from the
  new image and `container/agent/compose.agent.yaml` (`docker compose ... up
  -d`). `container/agent/accept.sh` refuses a container whose stop timeout
  is not 45 seconds or whose healthcheck is not the service file's.
- **A platform that does not read the Compose file** gives the container a
  stop timeout of 45 seconds itself: `oats host run` gives each harness 20
  seconds to end, and Docker's default of 10 kills the agents before they
  are stopped in order.
- **Register the deployment for schedules once**, after `server connect`:
  `oats schedule host install --register-only --server team-agent`. The
  operator's OATS must be 0.69.15 or later for the option.

## Changed

- **The team agent image runs the kernel's periodic work.** Its entrypoint
  starts sshd in the background and ends in `exec oats host run`, so that
  command is tini's direct child, the process the runtime's SIGTERM reaches
  and the container waits for. At start it resumes the sessions lost when
  the container last stopped, then runs the schedule tick each minute for
  the registered deployments; on `docker stop` it stops the agents in order
  and the next start resumes them
  ([container.md](../container.md#the-kernels-periodic-work)).
  - The image pins OATS 0.69.15, the first release with `oats host run`.
  - The Compose service sets `stop_grace_period: 45s`.
  - The Compose service has a healthcheck that opens sshd's port,
    `127.0.0.1:2222`, every 30 seconds. `oats host run` does not supervise
    sshd, and Docker does not restart an unhealthy container: when
    `docker inspect --format '{{.State.Health.Status}}'` reads `unhealthy`,
    `docker restart` the container.
  - The acceptance script requires the 45-second stop timeout and that
    healthcheck in the container's inspect evidence.
