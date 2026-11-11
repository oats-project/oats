# Agent team container

`container/agent/` supplies an agent image and a Compose service for one
team's trust group. It runs non-root sshd on port 2222; the operator uses the
existing [server route](servers.md) to connect, preview and spawn. The
entrypoint creates private state directories and host keys, starts sshd,
then runs `oats host run`
([The kernel's periodic work](#the-kernels-periodic-work)). Deployment setup
and seat admission belong to the operator.

## One team, one trust group

The service runs every agent, sshd and `oats host run` as one user, so the
container is one trust group ([trust-model.md](trust-model.md)):

- **It is the unit of compromise.** If one agent in it is subverted, treat
  every agent, seat and credential in it as subverted. Each agent can read
  every seat under `/state/seats`, the Claude token and sshd's host keys,
  rewrite the launch configurations in `/state/deploy` and the schedule
  registry in `/state/home`, and stop sshd or `oats host run`.
- **It holds one team, never several.** Agents that must not be able to read
  each other's identities or affect each other's work get separate
  containers. Nothing in OATS makes sharing one safe.

## Configuration contract

The same inputs apply to a Compose service or a platform's container spec:

| Input | Purpose |
| --- | --- |
| Deployment repository and commit | Operator provisions `/state/deploy`; its `oats-lock.json` pins packages and souls. Record the source and lock commits in the receipt. |
| aweb/AWID endpoints and team identifier | Deployment configuration; the platform's egress allowlist admits the endpoints. |
| Operator SSH public key | Read-only `authorized_keys` mount. |
| Resource limits | Runtime pids, memory and CPU limits. |
| Approved mounts | Explicit list, checked against the running container. |
| Egress destination list | Platform's resolver/forwarder configuration, outside the agent container. |
| Harness launch environment | Non-secret literals or file references, resolved at process start. |

Credentials never go in the image, build arguments, Compose environment, env
files or OATS configuration literals. The operator provisions ordinary
member seats and an inference-only Claude setup-token. Team/controller keys,
owner authority and service credentials stay outside the container. A
`/login` credential or a copy of `~/.claude` must never enter it.

## Build and upgrade

From a checkout at the reviewed commit:

```sh
env -i PATH="$PATH" docker build --platform linux/arm64 \
  -t oats-agent:reviewed container/agent
```

Use `linux/amd64` on the target builder. The Dockerfile pins Node 22 Debian
Bookworm slim by its multi-architecture index digest; the committed
`package.json` and `package-lock.json` pin the CLI versions and npm integrity
hashes. `npm ci --ignore-scripts` installs the dependency closure. Only
`@awebai/aw` is rebuilt with lifecycle scripts, in a build step without a
network. Claude's matching native binary is linked directly from its locked
platform package, without running its installer. Each CLI's version command
must succeed during the build.

`libnss-wrapper` is the extra OS package needed for arbitrary UID support.
No credentials or SSH host keys are baked in. The build context allowlist
excludes everything except the image's five inputs.

A derived image may add reviewed OS tools with `USER root` and `RUN`, then
restore `USER agent`. Those build steps use the system passwd/group database.
The entrypoint enables nss_wrapper only after generating the runtime
database; SSH command environments also enable it. An overridden entrypoint
or `docker exec` uses system NSS, so an arbitrary numeric UID may have no
name there. Use the SSH route for commands that require the `agent` mapping.

CLIs upgrade only by building and selecting a new image. Global npm installs
fail on the read-only root. To update the OATS pin, change its one dependency
version and regenerate this directory's lock with
`npm install --package-lock-only --ignore-scripts`; review both files. Do not
use `--install-oats` or `--install-aw` against a running container.

The committed OATS 0.69.15 pin has `oats host run`, which the entrypoint
runs, and `oats schedule host install --register-only`. It supports
`env: { fromFile: ... }` and the operator's `oats harness token set` route.
Provision the token through the
[harness credential route](servers.md#harness-credentials) and collect live
acceptance evidence before claiming the two-seat inference milestone.

## Mounts and UID

The provisioner creates host directories with the runtime UID and GID.
The Compose defaults are `20001:20001`; use an explicit non-root UID:GID in
the target service so the group-readable token is readable.

The image also starts with a numeric UID alone, such as
`docker run --user 20001`. When that UID has no image passwd entry, Docker
assigns GID 0. The wrapper names that runtime group `agent`, and new files
in `/state` have GID 0. Such a run cannot read a root:20001 0750 login
directory or its 0440 token. Use `--user 20001:20001` for the team login;
the UID-only form proves startup and SSH support, not token access.

| Container path | Host ownership and mode | Access |
| --- | --- | --- |
| `/state` | Runtime UID:GID, 0700 | Read/write; persistent |
| `/work` (optional) | Runtime UID:GID, 0700 | Read/write |
| `/etc/agent-login` | root:runtime-GID, 0750; `claude-token` root:runtime-GID, 0440 | Read-only |
| `/etc/agent-ssh/authorized_keys` | root-owned regular file, 0644 | Read-only |
| `/etc/resolv.conf` | Operator-provided resolver file | Read-only |
| `/tmp` | tmpfs, rw,nosuid,nodev,mode=1777 | Ephemeral |

All binds use `create_host_path: false`: a missing path fails startup.
`/state/home`, `/state/ssh` and `/state/deploy` are created 0700 by the agent.
`HOME=/state/home`. nss_wrapper reads passwd/group files generated in
`/state/ssh`, mapping the name `agent` to the actual UID/GID. The root
filesystem and `/etc/passwd` remain read-only. SSH sessions receive the same
mapping and HOME. The `agent` user has no sudo.

Host keys persist in `/state/ssh`; agents in the trust group can read them.
sshd accepts only `agent` public-key authentication, with PAM, password and
keyboard-interactive authentication off. Forwarding is disabled: OATS's
ControlMaster multiplexing uses SSH command/session channels and needs no
TCP, agent or X11 forwarding. The operator's jump host must separately permit
the ProxyJump connection to the container.

## Compose integration

Supply these plain variables to the bundle's env file:

| Variable | Meaning |
| --- | --- |
| `TEAM` | Container name suffix: `oats-agent-${TEAM}`; service key is `agent`. |
| `AGENT_IMAGE` | Reviewed image tag or digest. |
| `AGENT_UID`, `AGENT_GID` | Runtime IDs; both default to 20001. |
| `TEAM_STATE_DIR` | Absolute host directory for `/state`. |
| `TEAM_WORK_DIR` | Optional absolute host directory for `/work`. |
| `TEAM_LOGIN_DIR` | Absolute host directory containing `claude-token`. |
| `AUTHORIZED_KEYS_FILE` | Absolute host public-key file. |
| `RESOLV_CONF_FILE` | Absolute host resolver file; always required. |
| `AGENT_PIDS`, `AGENT_MEMORY`, `AGENT_CPUS` | Positive limits; memory uses bytes, k, m or g. |
| `AGENTS_NETWORK`, `AGENT_IP` | Installer-created external network and container address. |

The bundle owns the network, resolver, forwarder, firewall and their bypass
checks. The agent service publishes no ports and sets no DNS or extra-hosts
override. It joins only the named external `agents` network. Its restart
policy is `unless-stopped`, its stop grace period is 45 seconds and its
healthcheck reads sshd's port
([The kernel's periodic work](#the-kernels-periodic-work)); security flags
are fixed in the service file.

```sh
docker compose -p "oats-team-${TEAM}" --env-file <plain-env-file> \
  -f compose.yaml -f container/agent/compose.agent.yaml config
docker compose -p "oats-team-${TEAM}" --env-file <plain-env-file> \
  -f compose.yaml -f container/agent/compose.agent.yaml up -d
```

When `TEAM_WORK_DIR` is set, append
`-f container/agent/compose.agent.work.yaml` to both commands. Otherwise omit
the override: the base has no `/work` mount. With multiple Compose files,
paths resolve relative to the first file; use absolute host paths. Container
down/upgrade preserves `/state`; the operator owns provisioning and rollback.

## OATS over SSH

The operator's SSH alias selects the key, host-key verification, port 2222
and jump route. The equivalent connection is:

```sh
ssh -J <provisioner>@<host> -p 2222 agent@<container-ip>
```

Register an already provisioned deployment, or connect it from the operator's
deployment using its source reference:

```sh
oats server add team-agent --ssh <ssh-alias> --workspace /state/deploy \
  --oats /usr/local/bin/oats --path /usr/local/bin:/usr/bin:/bin
oats server connect team-agent --ssh <ssh-alias> --dir /state/deploy \
  --oats /usr/local/bin/oats --path /usr/local/bin:/usr/bin:/bin
```

Use public HTTPS package pins unless a separate reviewed credential route
is provisioned. Verify `server connect` reports ready. Then register the
deployment for the schedule tick `oats host run` runs in the container
([The kernel's periodic work](#the-kernels-periodic-work)):

```sh
oats schedule host install --register-only --server team-agent
```

The operator places
two independently admitted ordinary-member identities at
`/state/seats/<alias>/.aw`; each spawn selects one:

```sh
oats spawn <soul> --server team-agent --harness claude --preview --provider oats.aweb identity.source=/state/seats/<alias>/.aw
```

Preview runs no provider hook and does not validate a missing seat. Apply
only after reviewing it and provisioning its seat; use the same arguments
without `--preview`. Keep the team and controller keys outside the container.

The pinned OATS release supports this file-backed launch configuration:

```yaml
launch-configs:
  team-claude:
    harness: claude
    env:
      CLAUDE_CONFIG_DIR: /state/home/.claude
      CLAUDE_CODE_OAUTH_TOKEN:
        fromFile: /etc/agent-login/claude-token
```

Select it with `--launch-config team-claude`. The operator provisions only a
`claude setup-token` result through the supported token route. It is readable
by every agent in the same trust group; read-only mounting does not hide it
or narrow its authority. Never share the mount across trust groups.

## The kernel's periodic work

A container has no launchd and no systemd user manager, so no timer runs
the kernel's periodic work in it. After the entrypoint prepares NSS and
SSH host keys, an image-local Node supervisor starts `aw wake run`. It waits
for `aw wake status --json` to report `daemon_running: true` while that child
stays alive, then starts sshd and `oats host run`
([desktop-cli-api.md](desktop-cli-api.md#the-host-run-oats-host-run)), one
foreground process that lasts as long as the container.

- **At start** it runs the resume sweep once, so the sessions that were lost
  when the container last stopped are started again
  ([Resume after a shutdown](execution-targets.md#resume-after-a-shutdown)).
  Then, at second 0 of every minute, it runs the schedule tick for the
  deployments the container's host schedule registry lists and lists the
  instances. With no deployment registered it ticks nothing and says so.
- **On the runtime's SIGTERM** (`docker stop`, `docker restart`, a Compose
  `down` or a recreate) it starts no further minute. Active launch work gets
  10 seconds to finish naturally; then a private admission fence prevents
  further schedule, trigger, wake or resume launches and owned children get
  a 5-second cancellation phase. An interrupted launch stays `unknown` and
  needs reconciliation; a timeout does not prove that nothing ran. Host run
  then lists and stops every running agent side by side: SIGTERM to the
  harness and a wait of 20 seconds, never escalated. Each home's stop record
  says it was stopped with the host, so the home reads `lost` and the next
  start's sweep resumes it. Then it exits 0 and the supervisor stops the
  broker. Work that cannot be killed retains the host-run claim; the runtime's
  final kill is a failed stop, never proof of an ordered shutdown.
- **Its progress** is one line per event on standard error, beside sshd's
  log, in `docker logs`.

What the image's files fix for that:

- **PID-only tini signals the Node supervisor.** It forwards TERM to host
  run alone and keeps the wake broker alive until host run finishes stopping
  the agents. Then it stops sshd and the broker. A broker or host-run exit is
  reported and drains the other children before a nonzero container exit, so
  the restart policy can restart it. The broker runs as the agent uid; its
  default state directory is `/state/home/.config/aw/wake`, so registrations
  survive container replacement and it starts again even with no spawn.
- **`stop_grace_period: 45s`** in the Compose service. Docker's default is
  10 seconds, shorter than the 20 seconds each harness is given; a container
  killed at the timeout leaves agents that were not stopped in order. A
  platform that does not read the Compose file needs the same stop timeout
  in its container spec.
- **A healthcheck on sshd.** The supervisor reports an sshd exit; if
  sshd ends, the agents and the tick go on and the operator's route is gone.
  The service's healthcheck opens `127.0.0.1:2222` every 30 seconds (5
  second timeout, 3 retries, 10 second start period), so the container then
  reads `unhealthy`. Docker does not restart a container for being
  unhealthy. Read it and restart the container; the stop is the ordered one
  above, and the next start resumes the agents:

  ```sh
  docker inspect --format '{{.State.Health.Status}}' "oats-agent-${TEAM}"
  docker restart "oats-agent-${TEAM}"
  ```

- **The tmux server a resume starts gets the entrypoint's environment**, its
  `PATH` and the nss_wrapper mapping included.

`oats host run` refuses to start while another one holds the container's
lock (`E_HOST_RUN_BUSY`); the container then exits 1 and the restart policy
starts it again. A lock left by an earlier run is taken over when its pid
is gone or has another process start time. A visible live holder, or a
holder whose start cannot be read, stays held; see
[Session recovery](execution-targets.md#which-losses-come-back).

The schedule tick covers only registered deployments. Register the
deployment once, after `server connect`
([OATS over SSH](#oats-over-ssh)):

```sh
oats schedule host install --register-only --server team-agent
```

or, in the container, `oats schedule host install --register-only --dir
/state/deploy` ([schedules.md](schedules.md#without-a-host-timer)). Plain
`host install` fails in a container after registering, since there is no
systemd user manager. The registry is in `/state/home`, so it persists
across container runs.

## Acceptance and evidence

The host needs Docker and Node 22.5+. Export the same plain variables used for
Compose, then run:

```sh
container/agent/accept.sh "oats-agent-${TEAM}" --evidence local
container/agent/accept.sh "oats-agent-${TEAM}" --evidence target-amd64
container/agent/accept.sh "oats-agent-${TEAM}" --evidence live-lab \
  --claude /state/deploy/agents/<soul>/instances/<instance>
```

Choose the label matching the actual run. `local` accepts the builder's
architecture; the other labels require amd64 and root:GID 0750
login-directory metadata, plus root:GID 0440 when a token is present.
If the token file is absent, its check reports `NOT RUN` and acceptance
continues; `claude -p` is skipped until the token exists. Do not create a
placeholder token. Local fixtures never use a real login.
Run the live Claude mode separately for each admitted instance home;
the home is an evidence label and an `instance.json` existence check. The
probe runs from a private temporary directory under `/tmp`, removed on
success or failure, with `--setting-sources user`. It uses the container's
user settings, excluding the instance's project settings, hooks and
`CLAUDE.md`, so the probe does not clear that live instance's waiting claim.
It reads the token only inside the container and requires the exact inference
response. It records no raw Claude output.

The script compares inspect settings and the exact bind list to the exported
variables. It resolves `AGENT_IMAGE` independently and requires that image's
ID, reference and start command, and its complete environment (printing only
names of differing variables). Other comparisons include supplementary
groups, namespace overrides, sysctls, published ports, resolver overrides
and the single network/address. The stop timeout must be 45 seconds and the
healthcheck the service file's, so a container made before either was set
is refused until it is recreated. The OCI runtime must match the daemon's
independently read default; shared memory stays at Docker's 64 MiB default,
the OOM killer stays enabled, and device cgroup rules stay empty. The total
memory-plus-swap setting is absent or Docker's default of twice the memory
limit; unlimited swap is refused.
It checks the process's UID/GID/supplementary groups/capabilities/no-new-privileges
and non-root sshd's banner, scans `/` as container root (pruning `/proc`,
`/sys`, `/dev` and the agent-scanned `/state`, `/tmp`, `/run`, `/work`),
and scans those trees plus writable `/dev/shm` and `/dev/mqueue` as the agent
for `.credentials.json`. When a token is present, it checks
that the token is readable and not writable. It proves a global npm install fails using an
offline local package. Scan errors fail acceptance. The root inspection
process receives no added capabilities. Token provenance still needs the
operator's receipt: permissions and successful inference cannot distinguish
all credential classes.

A successful script run covers those checks only. The complete platform
receipt also needs `server connect`, both admitted-seat spawn previews and
applies, the source/lock commit, viewer, package sync, the bundle's network
and bypass evidence, mail/chat exchange, governance refusals and any broker
checks. Record target evidence separately from local evidence. Container
startup and a local preview do not establish two running agents.

`test/agent-container.test.mjs` pins the image, Compose and SSH security
settings and the entrypoint's last two lines, and rejects weakened inspect
fixtures. The SSH guard requires flat
`Keyword value` lines and refuses duplicate keywords, `Match`/`Include`,
equals-delimited keywords and quoted keywords. Follow the repository's
local check limits; full suites run in CI.
