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
  registry in `/state/home`, rewrite the wake registrations under
  `/state/home/.config/aw/wake`, and stop sshd, `oats host run`, the wake
  broker or its supervisor.
- **It holds one team, never several.** Agents that must not be able to read
  each other's identities or affect each other's work get separate
  containers. Nothing in OATS makes sharing one safe.
- **Its Git credentials must not reach the workspace's own code.** A
  workspace member is used at its latest commit, so an agent that can push to
  a member's default branch changes what every deployment of that workspace
  runs ([trust-model.md](trust-model.md#code-from-outside-the-group)).

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
excludes everything except the explicitly listed image inputs.

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

The committed OATS 0.69.18 pin has `oats host run`, which the entrypoint
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
| `/tmp` | tmpfs, rw,nosuid,nodev,size=AGENT_TMP_SIZE,mode=1777 | Ephemeral; bounded by the configured byte limit |
| `/etc/agent-trust/ca.pem` | Optional public CA file, read-only | Operator-provisioned extra trust; no private keys |
| `/mirrors` | Optional bare Git mirror directory, read-only | Operator-refreshed source snapshots, outside writable state |

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
| `AGENT_TMP_SIZE` | Positive integer bytes from the shared configuration's `agents.tmpSize`; bounds the `/tmp` tmpfs. |
| `AGENT_CA_FILE` | Optional absolute public PEM path from `agents.caFile`; selects `compose.agent.trust.yaml`. |
| `AGENT_MIRRORS_DIR` | Optional absolute mirror directory from `agents.mirrorsDir`; selects `compose.agent.mirrors.yaml`. |
| `AGENTS_NETWORK`, `AGENT_IP` | Installer-created external network and container address. |

The bundle owns the network, resolver, forwarder, firewall and their bypass
checks. The agent service publishes no ports and sets no DNS or extra-hosts
override. It joins only the named external `agents` network. Its restart
policy is `unless-stopped`, its stop grace period is 45 seconds and its
healthcheck reads sshd's port
([The kernel's periodic work](#the-kernels-periodic-work)); security flags
are fixed in the service file.

Include `compose.agent.trust.yaml` only when `agents.caFile` is configured. It
adds one read-only mount at `/etc/agent-trust/ca.pem` and exactly two fixed
environment settings: `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`, both pointing
there before the supervisor starts. The file must contain only valid public CA
certificates, at most 64 KiB, with no private key. Go keeps its normal certificate
directories and Node extends its normal roots. The acceptance check validates
the file and the exact mount/environment pair; it permits no general environment
override. The broker and its Node verification child receive the same trust
settings. The immutable `/etc/profile.d/agent-trust.sh` also supplies the two
settings to the agent's captured login environment and tmux children when the
fixed CA file is readable. The image sources that same profile at the start of
the system bashrc, before its noninteractive return, for bash's SSH startup
path. sshd also fixes `BASH_ENV` to that profile for other noninteractive bash
commands; user environment and SSH rc overrides remain disabled. Without the
CA mount, the profile exports neither setting. Recreate the container after
changing a trust bundle so the broker, Node children and captured sessions all
start with the same approved anchors.
A successful probe using an explicit CA does not establish that the
real broker trusts it; prove that through the deployment's HTTPS registry.

Include `compose.agent.mirrors.yaml` only when `agents.mirrorsDir` is configured.
The operator provisions and refreshes the bare mirrors outside the container,
with no repository credentials, and the fragment mounts them read-only at
`/mirrors`. Keep both optional input sources outside every agent-writable bind
source, including symlink aliases: run acceptance on the Docker engine host so
it can resolve the actual sources. A CA file with multiple hardlinks is refused,
since a read-only bind cannot protect another writable link to the same file.
The wrapper renders the existing Git rewrite in
`/state/home/.gitconfig`:

```gitconfig
[url "file:///mirrors/github.com/"]
    insteadOf = https://github.com/
```

Retain the operator's exact source/ref/commit manifest and refresh time beside
the mirrors. A snapshot observes the last operator refresh; its presence does
not prove current membership or withdrawal freshness. The first deployment check
is `oats workspace status` with all members confirmed, followed by the actual
spawn preview. Do not enable all Git file transports or add a general Git-host
egress route to make that check pass. Kubernetes uses an explicit existing
`agents.kubernetes.mirrorsClaim` for the same read-only mount, separate from
state; it never turns the Compose directory into a hostPath.

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

The image account and the runtime NSS entry use `/bin/bash` as the login shell.
This lets OATS capture a fresh login environment rather than inheriting the tmux
creator's environment after a failed shell capture.

Compose fixes the container hostname to `oats-agent`, so replacement keeps the
hostname used by cache locks. Container names and network addresses still belong
to the deployment wrapper. A lock written under a former ephemeral hostname may
need one manual cleanup after checking that its holder is no longer running.

## Broker delivery before launch

Container deployments use the in-container broker with session delivery. Before
any spawn or resume, the bootstrap wrapper writes the existing setting in the
deployment's `oats-local.yaml`:

```yaml
settings:
  oats.aweb:
    delivery: session
```

A contradictory existing value must stop bootstrap with a fix naming
`settings.oats.aweb.delivery`; correct the deployment setting before restarting
it. Verify the effective value with `oats inspect` or the spawn preview's
`settings.oats.aweb`. The image and Compose also declare `AWEB_DELIVERY=session`
to silence ambient channel extensions; that variable alone does not select the
provider setting. The image has no Claude channel plugin.

## OATS over SSH

The operator's SSH alias selects the key and verifies the provisioned SSH host
key. The isolated agents bridge has no host gateway, so use the operator's
existing Docker context as a stdio relay to port 2222 inside the container:

```sshconfig
Host team-agent
  HostName oats-agent
  User agent
  Port 2222
  IdentityFile <operator-key-path>
  IdentitiesOnly yes
  UserKnownHostsFile <provisioned-known-hosts-file>
  StrictHostKeyChecking yes
  ProxyCommand docker --context <operator-context> exec -i <container> node -e 'const s=require("node:net").connect(2222,"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));'
```

Provision the public host key in that known-hosts file before connecting. The
Docker context belongs only to the operator; the agent receives no engine socket,
additional network or published port. `ssh team-agent` then uses the same SSH
authentication and host-key checks as an ordinary SSH transport.

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

The legacy VM migration route copies an already admitted ordinary-member
identity's private state into `/state/seats/<alias>/.aw`; each spawn selects one
through the existing `identity.source` input. Treat that copy as credential
provisioning, keep it private, and do not use a team or namespace controller
identity:

```sh
oats spawn <soul> --server team-agent --harness claude --preview --provider oats.aweb identity.source=/state/seats/<alias>/.aw
```

Preview runs no provider hook and does not validate a missing seat. Apply
only after reviewing it and provisioning its seat; use the same arguments
without `--preview`. Keep the team and controller keys outside the container.

### Making a seat

`identity.source` is the legacy route of `oats.aweb`: the spawn copies an
existing aweb identity into the new home and connects it. It is the route
that works in a container today, and it stays labelled legacy until the
package has a route that admits a seat itself.

A seat is the `.aw` directory of one admitted team member. On both routes
below the seat's signing key is created in the container, over the SSH
route, so it is on `/state` and never leaves it; the team's controller key
stays outside. Which route applies depends on who holds that controller key.

**A team whose controller key the operator holds** (a self-hosted server, or
a team the operator brought). The seat asks, the controller admits it, the
seat fetches its certificate:

```sh
# 1. In the container, once per seat. Prints the add-member command.
mkdir -p /state/seats/<alias> && cd /state/seats/<alias>
aw id team request --create-local-key --team <team>:<domain> --name <alias>

# 2. Outside the container, where the team's controller key is: run the
#    printed `aw id team add-member` command. It answers a certificate id.

# 3. In the container, in the same directory:
aw id team fetch-cert --team <team> --namespace <domain> --cert-id <certificate-id>
aw workspace connect --service <the team's aweb server>
```

An invite cannot be used here: a token made with the operator's own
controller key is redeemed only on the machine that holds that key
(`aw id team accept-invite --help`).

**A team hosted by the aweb service.** The service holds the controller key
and issues an invite token (`aw_inv_…`); the seat redeems it:

```sh
# In the container, once per seat:
mkdir -p /state/seats/<alias> && cd /state/seats/<alias>
aw id team accept-invite <token> --name <alias>
aw workspace connect --service <the team's aweb server>
```

The commands are as `aw` 1.36.57 documents them in its own `--help`. The
sequences have not yet been run in a container.

Before it copies anything, the spawn checks three things and refuses the
seat when one is missing:

- `signing.key`, the member's key;
- the server: `aweb_url` in `workspace.yaml` (`aw workspace connect` writes
  it);
- the team: the deployment's default team, or else the active team in
  `teams.yaml`.

The member's certificate under `team-certs/` is not checked at that point,
and the seat does not work without it: the spawn copies the seat, fails when
it connects or reads the identity back, and removes the copy.

One seat serves one instance at a time. The spawn writes
`.aw-retained-seat.json` beside the seat's `.aw` and refuses a second spawn
while the first instance's home exists; retiring that instance releases the
seat. Two cases need the operator:

- **The holder's home exists and its runtime is known to be dead.** Spawn
  with `identity.takeOver=true`. If that runtime is in fact alive, there are
  then two seats with one key; stop the old one.
- **The holder's home is gone without a retire** (a home removed by hand, a
  volume restored). Every later spawn is still refused, as "taken by another
  spawn a moment ago", and `identity.takeOver` does not apply. Remove
  `.aw-retained-seat.json` by hand once the home is confirmed gone
  ([awebai/oats-aweb#227](https://github.com/awebai/oats-aweb/issues/227)).

Retiring never revokes the member's certificate: on a server that is not the
hosted service, whoever holds the controller key removes a member
(`aw id team remove-member`).

Known limits of this route, until their fixes are released:

- **A restart can lose the seat's identity.** A seat made this way may not
  get `AWEB_IDENTITY_HOME` at a restart
  ([awebai/oats-aweb#226](https://github.com/awebai/oats-aweb/issues/226)).
  Check `aw whoami` in the home after a restart; if it is not the seat, retire
  the instance and spawn it again.
- **Do not interrupt a seat's spawn.** A spawn killed after it connected can
  delete the standing identity's workspace at the server
  ([awebai/oats-aweb#228](https://github.com/awebai/oats-aweb/issues/228)).

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

### After changing a credential

A resume starts an agent under the values its last start recorded. When the
value behind a reference has changed, such as a new token in
`/etc/agent-login/claude-token`, every resume of that home is refused with
`E_LAUNCH_ENV_CHANGED`, by the sweep and by hand
([execution-targets.md](execution-targets.md#resume-after-a-shutdown)). The
agents do not come back when the container restarts, and host run's log
shows them as `refused`.

So after replacing a referenced credential, start each agent once yourself.
An ordinary start does not compare; it uses the new value and records it:

```sh
# In the container:
oats session restart --home <abs>   # an agent that runs
oats session start --home <abs>     # one that is stopped
```

An ordinary start begins a new conversation; it does not resume the earlier
one.

### Where conversations are stored

With `CLAUDE_CONFIG_DIR: /state/home/.claude`, Claude Code writes each
session's transcript under that directory. It holds what the agents read and
wrote, tool output included: mail they opened, and the results of calls made
on their behalf.

- It is one directory for every agent of the container, and every agent can
  read it ([One team, one trust group](#one-team-one-trust-group)).
- It is on `/state`, so it outlives the container and is in any copy of the
  volume.
- OATS neither trims nor deletes it. Retiring an instance removes its home,
  not its transcripts. The operator decides how long they are kept and
  removes them.

## The kernel's periodic work

A container has no launchd and no systemd user manager, so no timer runs
the kernel's periodic work in it. After the entrypoint prepares NSS and
SSH host keys, an image-local Node supervisor starts `aw wake run`. It waits
for `aw wake status --json` to report `daemon_running: true` and name that
live child's PID as `daemon_pid`, then starts sshd and `oats host run`
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
  the agents. Then it stops sshd and the broker in parallel. A broker or
  host-run exit is reported and drains the other children before a nonzero
  container exit, so
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

## Image CI and publication

[Team image](../.github/workflows/team-image.yml) builds `container/agent`
from the pull request's exact head commit, on an Ubuntu 24.04 amd64 runner.
It also supports a manual verification run at the selected ref. Actions are
pinned by commit, and the verification token has only `contents: read`.
After acceptance, verification also runs the real Docker export, Skopeo
compression and configuration-digest checks used before publication, without
a registry credential or any registry/release write.

Manual verification offers two additional proofs:

- `default_payload_proof` builds the registry context a second time without
  the additive BuildKit mount and compares the full installed `/opt/agent`
  payload: file paths, sizes, content hashes, modes, directories and link
  targets. Image history and IDs may differ; payload differences fail.
- `packed_kernel` prepares a private context from the selected commit and
  runs the image with that commit's own `npm pack` kernel. This job is
  manual-only until the image owner's compatible final baseline lands.
  Ordinary PR verification keeps the committed context in the meantime.
  An incompatible baseline fails explicitly, with no registry-kernel fallback
  and no wider lock allowance. The committed baseline needs final OATS
  0.69.18+ and aw 1.36.59+ with the compatible exact runtime closure.
  With the committed baseline, the packed job refuses; its positive real
  packed-image acceptance is **NOT RUN** until that compatible baseline lands.

Packing disables lifecycle scripts and uses a private npm home/cache, empty
user/global configs and an explicit public registry. Every packed file must
be in the kernel's literal `package.json.files` list, including the explicitly
declared manifest and license. The tarball is checked against its SHA512
integrity and the exact checkout's regular Git files, sizes, bytes and modes;
links, unsafe paths and untracked/generated payloads refuse. The source
checkout stays unchanged.

Only the private image manifest changes to the fixed
`file:../oats-build-inputs/oats-pr-kernel.tgz` dependency. The same tarball is
provided in the closed context and a private host-side sibling directory,
so npm lock generation and the build resolve the same bytes. The existing
`npm ci --ignore-scripts` RUN gets a read-only context mount at
`/opt/oats-build-inputs`; no tarball COPY, build argument, new lifecycle
execution or runtime mount is added. The registry release context and its
strict metadata checks keep their own path. Both adapters protect every
unrelated CLI and lock entry, addition, removal and root/metadata field.

After the unmodified acceptance, the packed job checks the installed kernel's
exact own-file set, sizes, modes and hashes against the HEAD inventory in
the same accepted container. Version equality alone is insufficient: two
commits may share a version. Separately resolved nested dependencies remain
governed by the image lock. A changed inventory artifact or installed file
fails before digest preparation. The closed context, tarball, generated
manifest/lock, source inventory and build metadata are retained as artifacts;
npm config/cache are outside the uploaded context. Source SHA and
integrity/inventory/lock hashes are retained in those artifacts. Acceptance
reports the image ID in its log and passes it between workflow steps to bind
the export to the accepted image. These checks do not broaden the receipt's
supervisor, agent or containment claims.

The shared fixture, `.github/scripts/team-image-accept.sh`, starts the
committed Compose service on a disposable internal bridge with IPv6 off and
an isolated gateway (Docker Engine 28+). It provisions private state, a
throwaway SSH public key, a resolver file and an empty root:20001 0750 login
directory, waits for the service's SSH healthcheck, then runs the image's
unmodified `accept.sh --evidence target-amd64`. Cleanup removes the service,
network and fixture paths on success or failure. This is image acceptance;
it provisions no seat or inference token. The script's `NOT RUN` items
remain outside this check.

The `publish-team-image` job in
[Release](../.github/workflows/release.yml) waits for the existing `publish`
job, so npm publication and the GitHub Release precede the image. Its
single job-level `if: ${{ false }}` keeps publication disabled pending the
registry decision for the proposed `ghcr.io/oats-project/team-agent` target.
GHCR creates a new package as private by default. Verification remains
enabled. Enabling publication requires the registry decision and a reviewed
change to the switch.

Before enabling, the registry owner must complete these separately authorized
setup steps and include their evidence as a checklist in the enabling PR:

1. Push the approved digest from a verified run.
2. Set the package visibility to public.
3. Grant this repository's Actions write access.
4. Record the pinned-client observation that an unused exact version tag
   returns `manifest unknown`.

Package creation is this manual setup step, never an automatic release-job
bootstrap. The job treats only `manifest unknown` as an absent tag. It refuses
`name unknown`, `denied`, authentication and transport errors. The registry
owner resolves bootstrap and access problems without broadening the matcher.

Publication requires a stable `vX.Y.Z` release tag (at least 0.69.18).
The release job copies only the tagged image's literal `.dockerignore`
allowlist into a private build context, sets its OATS dependency to exactly
`X.Y.Z`, and regenerates that copy's lock with npm scripts disabled and the
public registry selected explicitly. The source checkout and Dockerfile
stay unchanged. The committed aw pin must be a final version of at least
1.36.59 and match its lock; prereleases cannot pass the guard.

The generated lock may change only the OATS entry, its root dependency
specification and its own exact runtime dependencies. Other entries,
including aw, Claude and unrelated transitive packages, must remain equal
to the committed lock, including additions and removals. Registry version,
tarball URL and SHA512 integrity must match the new kernel and its exact
dependencies. A missing compatible committed baseline fails the build;
it does not widen the allowance. The image owner maintains that baseline.
The effective manifest, generated lock and source/version/integrity metadata
are retained as a run artifact. Lock regeneration is audited rather than
claimed to reproduce the entire image across retries.

After building the private context, the release job runs the existing real
acceptance and separately executes `oats version --json` in that same
container. The installed kernel must equal `X.Y.Z` before registry login.
The fixture records the accepted container's image ID. Export must inspect
that same ID, then use `docker save` on the immutable ID. Skopeo reads the
archive and compresses layers into a private directory, preserving its
Docker v2s2 manifest type. Docker's CLI negotiates the Engine API; Skopeo
uses no daemon connection. The release lane installs and verifies the
reviewed Ubuntu Skopeo package version `1.13.3+ds1-2ubuntu0.24.04.3`, whose
error text it parses; changing that input requires another review and real
preparation run. PR verification installs the available archive package
without an exact apt pin and records its version in the step summary.

Keeping the manifest type avoids rewriting configuration bytes. The
prepared configuration digest must equal the hash of the archive's raw
configuration, binding the manifest and root filesystem to the accepted
image. This binding uses archive bytes rather than assuming Docker's image
ID is a configuration digest. The classic store has real runner evidence;
the containerd store branch has fixture coverage and still needs a real run.
Skopeo [copies with preserved digests](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
to `repository@sha256:...`.

The same manifest also gets the exact release retention tag `X.Y.Z`, with
no leading `v`, `latest`, major or minor aliases. Before any registry write,
a different digest at that tag is refused; a same-digest retry is idempotent.
Only an explicit manifest-not-found result permits creation. Authentication,
transport and other lookup errors fail closed. After copying the digest,
the job copies the same manifest to the absent version tag and verifies its
resolved digest. The release workflow serializes its own writes; this
preflight is not a registry compare-and-swap against independent writers.
Deployments, chart values, deploy/team and release receipts continue to use
the digest reference. The version tag is for retention and human inspection.

After the version tag is written, a failed final verification or receipt edit
requires manual recovery of that published digest: verify the existing tag
against the original run's retained build inputs and acceptance evidence, then
restore its owned receipt block. Use the original digest output/summary when
available; a failed final inspect may precede that output. A workflow rerun
rebuilds and can yield a different digest that correctly refuses. Never retag
to make the rerun pass.

The digest is a job output and appears in the run summary. An owned block
in the existing GitHub Release notes records the immutable image reference,
source tag and commit, installed kernel, generated lock hash and npm kernel
integrity. A retry replaces only that image's block, preserving other prose.
The receipt's PASS list covers image build, non-root user, read-only root,
sshd startup and image/configuration digest binding. Supervisor startup,
admitted-seat spawn, wake delivery, package sync, inference, mail/chat,
viewer, governance, platform containment and network/egress-bypass checks
remain **NOT RUN**. Version and lock checks do not prove supervisor startup
or agent readiness; those claims need direct acceptance coverage.

Only that job has `packages: write`; `contents: write` lets it replace its
owned receipt block. Among run-step environments, only the publish step
receives `GITHUB_TOKEN`. The SHA-pinned first-party checkout and setup-node
actions use their default action token inputs; checkout does not persist
credentials. The publish step stores
registry authentication in a private temporary file and removes it on exit.
It receives no npm publish credential. To roll back a deployed image, select
the previous reviewed digest in the deployment configuration.

## Egress component

The generic [egress image and service](../container/agent/egress/README.md) live
with the agent image. The deployment wrapper owns its allowlist and derives the
non-secret runtime policy from the shared deployment configuration and signer
profile. The proxy permits only the named API and registry routes and serves
only the declared public namespace authority records. Service custody keys,
PostgreSQL, Redis and the Docker socket stay outside the agent container.

Network membership, CNI enforcement and ingress Host/SNI agreement require runtime
proof before launching agents. An internal bridge, a NetworkPolicy object or a
healthy proxy alone does not prove the boundary. The [service descriptor](../container/agent/egress/descriptor.md)
supplies the wrapper mapping without a separate operator schema.

For Kubernetes, liveness runs `node /usr/local/lib/agent-liveness.mjs` to check
the supervisor process. SSH on port 2222 is readiness: losing SSH must not
restart the whole team while its agents and broker are still running. The
container's 45-second termination window includes the kernel and supervisor
shutdown phases; the nominal phase sum leaves little overhead margin.
