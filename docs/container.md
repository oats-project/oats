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
  broker or its supervisor. With an optional child, each agent can also
  reach every loopback port the child holds
  ([An optional child](#an-optional-child)).
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
  --build-arg "TEAM_IMAGE_SOURCE_SHA=$(git rev-parse HEAD)" \
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

The committed OATS 0.70.7 pin has `oats host run`, which the entrypoint
runs, and `oats schedule host install --register-only`. It supports
`env: { fromFile: ... }` and the operator's `oats harness token set` route.
Provision the token through the
[harness credential route](servers.md#harness-credentials) and collect live
acceptance evidence before claiming the two-seat inference milestone.

## Run contract

The digest selects both an image and its deployment files. Extract each image's
`/opt/oats/deploy` into its own run directory; the shared files must have identical
hashes when the images come from the same source commit. Agent files are at the
root; egress files retain the `egress/` subdirectory. The image builds require
`--build-arg TEAM_IMAGE_SOURCE_SHA=<full 40-character commit SHA>` and refuse a
missing or malformed value, with no `unknown` fallback.
([Agent Dockerfile](../container/agent/Dockerfile),
[egress Dockerfile](../container/agent/egress/Dockerfile),
[manifest builder](../container/agent/deploy-manifest.mjs),
[cross-image CI check](../.github/scripts/team-image-deploy-check.mjs).)

### Agent runtime

The entrypoint is `tini -- /usr/local/bin/agent-entrypoint`, which creates the
runtime NSS database and persistent SSH keys, then executes
`node /usr/local/lib/agent-supervisor.mjs`. Neither entrypoint script nor
supervisor consumes positional arguments. The Dockerfile sets no `CMD` override
of the pinned Node base. Its image user is `agent` (UID assigned by `useradd`,
not a fixed deployment UID); Compose explicitly selects non-root
`${AGENT_UID:-20001}:${AGENT_GID:-20001}`. The entrypoint refuses root.
([Dockerfile](../container/agent/Dockerfile),
[entrypoint](../container/agent/entrypoint.sh),
[supervisor](../container/agent/supervisor.mjs),
[Compose](../container/agent/compose.agent.yaml).)

Compose requires a read-only root, drops all capabilities and sets no new
privileges. These host binds must exist; Compose never creates a missing source.
The operator provisions the ownership below. Acceptance checks `/state` and
its 0700 subdirectories and the target/live login metadata; sshd uses strict
public-key file modes. The resolver must be readable by the runtime user.
([Compose](../container/agent/compose.agent.yaml),
[entrypoint](../container/agent/entrypoint.sh),
[sshd configuration](../container/agent/sshd_config),
[acceptance](../container/agent/accept.mjs).)

| Input → container path | Ownership / access |
| --- | --- |
| `TEAM_STATE_DIR` → `/state` | Runtime UID:GID; writable persistent state; `home`, `ssh`, `deploy` created 0700 |
| `TEAM_LOGIN_DIR` → `/etc/agent-login` | Read-only; target/live evidence requires root:runtime-GID 0750; optional `claude-token` root:runtime-GID 0440 |
| `AUTHORIZED_KEYS_FILE` → `/etc/agent-ssh/authorized_keys` | Read-only root-owned regular file, 0644 |
| `RESOLV_CONF_FILE` → `/etc/resolv.conf` | Read-only operator-provided resolver; readable and non-empty to the runtime UID |
| `/tmp` | Writable tmpfs, mode 1777, `nosuid,nodev`, bounded by `AGENT_TMP_SIZE` |

Optional fragments add `/work` (writable runtime-owned work), `/inputs`
(read-only shared inputs), `/outbox` (writable runtime UID:dedicated non-root
outbox-GID, mode 2750 with an operator-owned parent), `/mirrors` (read-only bare
Git mirrors) and `/etc/agent-trust/ca.pem` (read-only public CA only). Outbox adds
its supplementary group; trust adds only `SSL_CERT_FILE` and
`NODE_EXTRA_CA_CERTS` pointing at that CA. Acceptance refuses overlapping optional
inputs/outbox and writable bind sources. Every bind source must be absolute.
([Work](../container/agent/compose.agent.work.yaml),
[inputs](../container/agent/compose.agent.inputs.yaml),
[outbox](../container/agent/compose.agent.outbox.yaml),
[mirrors](../container/agent/compose.agent.mirrors.yaml),
[trust](../container/agent/compose.agent.trust.yaml),
[acceptance](../container/agent/accept.mjs).)

The agent joins only `AGENTS_NETWORK` at `AGENT_IP`, uses the mounted resolver
and publishes no host ports. Port 2222 is exposed for SSH. Compose health opens
TCP 127.0.0.1:2222 every 30 seconds (5-second timeout, three retries, 10-second
start period). Compose sets `restart: unless-stopped`: process exit restarts the
container unless the operator stopped it; unhealthy alone does not.
For a separate orchestrator's liveness, `node /usr/local/lib/agent-liveness.mjs`
checks the supervisor. Readiness and liveness are distinct. The supervisor gates
sshd and host-run startup on broker readiness. None of these startup checks
admits a seat or proves platform containment.
([Compose](../container/agent/compose.agent.yaml),
[Dockerfile](../container/agent/Dockerfile),
[liveness](../container/agent/liveness.mjs),
[supervisor](../container/agent/supervisor.mjs),
[acceptance limits](../container/agent/accept.mjs).)

### Egress runtime

The entrypoint is `tini -- node /opt/egress/supervisor.mjs`; the Dockerfile sets
no `CMD` override, and the supervisor consumes no positional arguments. Image
and Compose both use UID:GID `10001:10001`. Compose requires a read-only root,
all capabilities dropped, no new privileges and IP forwarding disabled. Its
only persistent input is `EGRESS_POLICY_FILE` → `/etc/egress/policy.json`, a
read-only public JSON policy, regular file at most 64 KiB, readable by UID 10001
and provisioned by the operator; it contains no service credentials. There is
no writable state bind. `/tmp` is a writable 16 MiB tmpfs, mode 1777, with
`nosuid,nodev`; generated DNS/proxy configuration goes into `/tmp/egress`
(directory 0700, files 0600). Before starting any child, the supervisor also
writes `/tmp/egress/policy.hash` (0400): the canonical `policyHash` of the exact
policy it compiled, and nothing else. The proxy compiles the policy once, so a
changed policy file needs the proxy recreated.
([Dockerfile](../container/agent/egress/Dockerfile),
[Compose](../container/agent/egress/compose.egress.yaml),
[policy loader](../container/agent/egress/policy.mjs),
[supervisor](../container/agent/egress/supervisor.mjs).)

The proxy joins `agents` at `EGRESS_ADDRESS` and `services`. The minimal wrapper
owns the explicit IPv4 IPAM and isolated internal agents bridge. The agent's
resolver must select the proxy address; DNS zone answers and permitted TLS SNI
routes come from the mounted policy, with explicit external resolver addresses
required for external roles. Exposed ports are 53 UDP/TCP and 443 TCP; neither
fragment publishes host ports. `/opt/egress` retains exactly `policy.mjs`,
`supervisor.mjs`, `external.mjs`, `health.mjs`, `probe-ingress.mjs`.
([Service](../container/agent/egress/compose.egress.yaml),
[minimal wrapper](../container/agent/egress/compose.minimal.yaml),
[policy compiler](../container/agent/egress/policy.mjs),
[Dockerfile](../container/agent/egress/Dockerfile).)

Compose health runs `node /opt/egress/health.mjs` every five seconds (3-second
timeout, three retries, 5-second start period). It checks a declared DNS answer,
unlisted DNS refusal and a local TLS listener. The supervisor stops the component
if either child fails. Compose sets `restart: unless-stopped`: process exit,
including the supervisor stopping after a child failure, restarts the container
unless the operator stopped it; unhealthy alone does not.
Health alone grants no network admission: the wrapper
must pass the read-only engine-host network preflight before creating networks,
then the boundary probe and applicable ingress probe before agents start.
Every deployment that creates its own agents/services networks, including
wrappers other than `compose.minimal.yaml`, must distinguish creation from a
rerun. Supply all six planned inputs: `AGENTS_SUBNET`, `AGENTS_GATEWAY`,
`AGENT_IP`, `EGRESS_ADDRESS`, `SERVICES_SUBNET`, `SERVICES_GATEWAY`.

- Neither network exists: from the extracted egress run directory on the Linux
  engine host, run `node egress/preflight-network.mjs` immediately before
  creation. Require exit 0 before sourcing its six assignments or creating
  anything. Remote contexts and Docker connection overrides are refused.
- Exactly one network exists: refuse; the operator must clean up the partial
  pair before retrying.
- Both networks exist: do not rerun the preflight, whose overlap veto would
  refuse the project's own networks. The consumer wrapper must require both
  networks' `com.docker.compose.project` labels to equal its project, and both
  complete IPAM inventories to match the plan exactly: agents/services subnet
  and gateway, without extra ranges. Require the agents network to be internal,
  both networks IPv4-only, and the agents bridge's gateway mode `isolated`.
  Refuse any difference.

These existence, label and exact-plan checks belong to the consumer wrapper;
the preflight script remains a creation-time overlap check. Routes or links
added later are outside that check's promise. Self-owned networks must keep
only the proxy attached to both agents and services. The boundary probe then
proves the live shape before admission.
([Health](../container/agent/egress/health.mjs),
[supervisor](../container/agent/egress/supervisor.mjs),
[Compose](../container/agent/egress/compose.egress.yaml),
[network plan](../container/agent/egress/compose.minimal.yaml),
[network preflight](../container/agent/egress/preflight-network.mjs),
[boundary probe](../container/agent/egress/probe-compose-boundary.mjs),
[ingress probe](../container/agent/egress/probe-ingress.mjs).)

### Deploy inventory and extraction

Both images' deploy directories are root-owned, directories 0755 and files
0644, except the agent's `accept.sh` at 0755. The agent carries every
`compose.agent*.yaml`, `accept.sh`, `accept.mjs` and its import `supervisor.mjs`.
Egress carries `egress/compose.egress.yaml`, the documented deployment input
`egress/compose.minimal.yaml`, `egress/preflight-network.mjs`, and
`egress/probe-compose-boundary.mjs` with `boundary.mjs`, `policy.mjs`,
`canary.mjs`, `probe-runtime.mjs`, `split.mjs` beside it, the services-host
witness `egress/probe-services-backends.mjs`, plus root `accept.mjs`,
`supervisor.mjs`, `compose.agent.yaml`. Preserve this hierarchy when extracting;
the minimal wrapper's `../compose.agent.yaml` stays inside the extracted set.
([Agent Dockerfile](../container/agent/Dockerfile),
[egress Dockerfile](../container/agent/egress/Dockerfile),
[portable-copy tests](../test/team-image-deploy.test.mjs).)

`manifest.json` has exactly `{schema:1,image:"agent"|"egress",source,files,installed}`.
`source` is the full source commit SHA. `files` maps every other regular file's
relative path to `sha256:<64 lowercase hex>`; the manifest excludes itself.
No other file may exist in the directory. `installed` records version strings
read from the built image: agent `oats`, `aw`, `claude` via `oats version --json`,
`aw version`, `claude --version`; egress `coredns`, `nginx` via `coredns -version`,
`nginx -v`. The manifest is an inventory bound by the image digest, not a separate
signature or another deployment pin.
([Manifest builder](../container/agent/deploy-manifest.mjs),
[CI inventory/metadata verification](../.github/scripts/team-image-deploy-check.mjs).)

On the deployment host, extract without starting the image. Run once for each
pinned digest, using separate run directories (`DEPLOY_KIND=egress` for egress).
The Node 22 verifier below compares the complete directory with the manifest,
including hashes. An agent/egress pair from different source commits is never
valid: the consumer must refuse differing `source` values or differing hashes
for any shared file (`accept.mjs`, `supervisor.mjs`, `compose.agent.yaml`), even
when each image verifies independently. The pair check follows the individual
file verification below.
`docker cp` gives the host copy the invoking user's ownership; verification
checks content, not that the extracted files retain the image's root ownership
or modes.
([CI extraction and verification](../.github/scripts/team-image-deploy-check.mjs).)

```sh
export DEPLOY_KIND=agent DEPLOY_IMAGE='registry.example/team-agent@sha256:<digest>'
mkdir -p "run/$DEPLOY_KIND"
cid=$(docker create "$DEPLOY_IMAGE")
docker cp "$cid:/opt/oats/deploy/." "run/$DEPLOY_KIND/"
docker rm "$cid"
node --input-type=module - "run/$DEPLOY_KIND" "$DEPLOY_KIND" <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,image]=process.argv.slice(2);
const manifest=JSON.parse(readFileSync(join(root,'manifest.json')));
assert.equal(manifest.schema,1); assert.equal(manifest.image,image);
assert.match(manifest.source,/^[a-f0-9]{40}$/);
const files={};
function walk(dir,prefix='') {
  for(const name of readdirSync(dir)) {
    if(!prefix && name==='manifest.json') continue;
    const path=join(dir,name), rel=prefix+name, stat=lstatSync(path);
    if(stat.isDirectory()) walk(path,rel+'/');
    else {
      assert.ok(stat.isFile(),rel);
      files[rel]='sha256:'+createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
}
walk(root); assert.deepEqual(files,manifest.files);
console.log(image,manifest.source,manifest.installed);
JS
```

After extracting and verifying both sets, refuse a mixed pair before any
network creation or admission. This also catches missing shared files.
([CI pair verifier](../.github/scripts/team-image-deploy-check.mjs).)

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const agent=JSON.parse(readFileSync('run/agent/manifest.json'));
const egress=JSON.parse(readFileSync('run/egress/manifest.json'));
assert.equal(agent.source,egress.source,'agent and egress must come from the same source commit');
for(const file of ['accept.mjs','supervisor.mjs','compose.agent.yaml']) {
  assert.match(agent.files[file],/^sha256:[a-f0-9]{64}$/);
  assert.equal(agent.files[file],egress.files[file],'shared deploy file: '+file);
}
JS
```

### Versioned probe and live-lab inputs

From the extracted egress directory, run
`node egress/probe-compose-boundary.mjs --plan /absolute/runtime.json [--json]`
on the Linux Docker engine host. Plans require integer `"schema": 1` (one
engine) or `"schema": 2` (split agent/services hosts); the remaining fields are
the [Compose probe contract](../container/agent/egress/README.md#boundary-probe-on-an-existing-compose-deployment).
Missing schema refuses before engine access with
`E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found none; regenerate the plan with schema: 1 or schema: 2`.
Unknown numeric schema uses its number instead of `none`; other types use
`invalid <type>`. Exit status is 1; `--json` retains its static error document
and the named refusal appears on stderr. There is no unversioned fallback.
([Probe implementation](../container/agent/egress/probe-compose-boundary.mjs),
[schema regression](../test/team-image-deploy.test.mjs).)

When the agent host runs no services, the wrapper writes a schema-2 plan and
runs the probe from the extracted egress directory on the agent host, then
`node egress/probe-services-backends.mjs --plan /absolute/witness.json --json`
from the same image's extracted directory on the services host, and the
unchanged ingress probe there. Both checks refuse outside an extracted copy
(`E_EGRESS_SOURCE_MANIFEST`) and report the copy's manifest source as
`sourceCommit`. The wrapper binds the three with one `run`
(`{id, policyHash, servicesDeployment}`, where `policyHash` is the canonical
hash of the derived policy) and admits on the JSON documents, never on a PASS
line: the boundary's `mode:"split"` with every required row of its four
role-by-vantage results `DENIED`, the witness's selected containers, and the
same run, policy hash and source commit on all three. Older probes refuse a
schema-2 plan with their schema-1 text.
([Split hosts and witness contract](../container/agent/egress/README.md#split-agentservices-hosts),
[witness](../container/agent/egress/probe-services-backends.mjs).)

From the extracted agent directory, invoke
`./accept.sh CONTAINER --evidence local|target-amd64|live-lab [--claude INSTANCE_HOME]`.
It needs host Node 22.13+ on 22.x, 23.4+ on 23.x, or a newer major, and Docker
CLI access to the engine running that container.
Docker connection settings are inherited by its CLI calls; no host token argument
or environment input is read. `--help` is the existing usage-only refusal
(exit 1), not a successful help command. Both argument options are available in
all three evidence modes. `--claude` requires an instance home under
`/state/deploy/`; if the mounted setup-token is present, it performs the live
inference check from a scratch directory with user settings only. Without the
token or without `--claude`, inference reports `NOT RUN`.
([Wrapper](../container/agent/accept.sh),
[acceptance implementation](../container/agent/accept.mjs).)

Acceptance consumes these plain host environment inputs, matching the reviewed
Compose configuration. Every optional input set to `""` is treated as unset;
empty UID/GID values select the 20001 defaults via both acceptance and Compose
`${VAR:-default}`. Include an optional mount fragment only when its source input
is non-empty; the fragment's `${VAR:?...}` refuses an absent or empty source.
An outbox directory requires a non-empty outbox GID. Acceptance resolves host
paths on the Docker engine host.
`local` permits the builder architecture and its local credential modes;
`target-amd64` and `live-lab` both require x64 and the target login ownership
listed above. Mode labels do not broaden the evidence: platform bypass,
admitted-seat spawn, viewer, sync, mail/chat and governance remain `NOT RUN`.
It also reads `/etc/resolv.conf` inside the running container as the runtime
UID and refuses an unreadable or empty file with
`E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID`.
([Input and evidence checks](../container/agent/accept.mjs),
[empty-input regression](../test/agent-container.test.mjs),
[resolver regression](../test/team-image-deploy.test.mjs),
[real root:0600/empty resolver fixture](../.github/scripts/team-image-accept.sh).)

| Inputs | Contract |
| --- | --- |
| `AGENT_IMAGE`, `AGENTS_NETWORK`, `AGENT_IP` | Exact reviewed image reference, single network and address |
| `TEAM_STATE_DIR`, `TEAM_LOGIN_DIR`, `AUTHORIZED_KEYS_FILE`, `RESOLV_CONF_FILE` | Required absolute bind sources |
| `AGENT_PIDS`, `AGENT_MEMORY`, `AGENT_CPUS`, `AGENT_TMP_SIZE` | Required positive resource limits matching inspect |
| `AGENT_UID`, `AGENT_GID` | Optional, default `20001` each |
| `TEAM_WORK_DIR`, `TEAM_INPUT_DIR`, `AGENT_CA_FILE`, `AGENT_MIRRORS_DIR` | Optional absolute bind sources; corresponding fragments required |
| `TEAM_OUTBOX_DIR`, `TEAM_OUTBOX_GID` | Both together; absolute export queue and its supplementary group |
| `AGENT_CHILD` | Optional declared child name, 1–20 lowercase letters/digits/dashes; must match the derived image's declaration and fragment |

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
| `/outbox` (optional) | Runtime UID:dedicated outbox-GID, 2750 (setgid); operator-owned parent | Read/write export queue shared with every agent |
| `/work` (optional) | Runtime UID:GID, 0700 | Read/write |
| `/inputs` (optional) | Operator-provisioned directory, readable by runtime UID:GID | Read-only; shared with every agent in the trust group |
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
| `TEAM_INPUT_DIR` | Optional absolute host directory for `/inputs`; selects `compose.agent.inputs.yaml`. |
| `TEAM_OUTBOX_DIR` | Optional absolute host export-queue directory for `/outbox`; selects `compose.agent.outbox.yaml`. |
| `TEAM_OUTBOX_GID` | Dedicated non-root numeric supplementary group for `/outbox`, distinct from `AGENT_GID`; required with `TEAM_OUTBOX_DIR`. |
| `TEAM_LOGIN_DIR` | Absolute host directory containing `claude-token`. |
| `AUTHORIZED_KEYS_FILE` | Absolute host public-key file. |
| `RESOLV_CONF_FILE` | Absolute host resolver file; always required. |
| `AGENT_PIDS`, `AGENT_MEMORY`, `AGENT_CPUS` | Positive limits; memory uses bytes, k, m or g. |
| `AGENT_TMP_SIZE` | Positive integer bytes from the shared configuration's `agents.tmpSize`; bounds the `/tmp` tmpfs. |
| `AGENT_CA_FILE` | Optional absolute public PEM path from `agents.caFile`; selects `compose.agent.trust.yaml`. |
| `AGENT_MIRRORS_DIR` | Optional absolute mirror directory from `agents.mirrorsDir`; selects `compose.agent.mirrors.yaml`. |
| `AGENTS_NETWORK`, `AGENT_IP` | Installer-created external network and container address. |
| `AGENT_CHILD` | Optional; the name of the declared child, when the derived image's fragment is included, for acceptance. `AGENT_IMAGE` is then that derived image. |

The bundle owns the network, resolver, forwarder, firewall and their bypass
checks. The agent service publishes no ports and sets no DNS or extra-hosts
override. It joins only the named external `agents` network. Its restart
policy is `unless-stopped`, its stop grace period is 50 seconds and its
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

A derived image that declares a child ships a fragment of its own. Include it
only for a team that runs that child. It sets exactly one fixed environment
entry, `AGENT_CHILD: "<name>"`, and adds no mount, port, network or
capability ([An optional child](#an-optional-child)).

Include `compose.agent.mirrors.yaml` only when `agents.mirrorsDir` is configured.
The operator provisions and refreshes the bare mirrors outside the container,
with no repository credentials, and the fragment mounts them read-only at
`/mirrors`. Keep all optional input sources outside every agent-writable bind
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

For provider input folders, provision one readable host directory outside every
agent-writable bind source, including symlink aliases. Set `TEAM_INPUT_DIR`
and append `-f container/agent/compose.agent.inputs.yaml` to both Compose
commands above. For example, with the bundle's other plain variables supplied:

```sh
TEAM_INPUT_DIR=/srv/example-team/inputs docker compose -p "oats-team-${TEAM}" \
  --env-file <plain-env-file> -f compose.yaml \
  -f container/agent/compose.agent.yaml \
  -f container/agent/compose.agent.inputs.yaml up -d
```

The operator creates and populates the directory first; a missing source fails
startup without creating a host directory. The fragment adds only a read-only
bind at `/inputs`. Omit the fragment and unset `TEAM_INPUT_DIR` to run the base
without `/inputs`; pass the same reviewed variables to `accept.sh`.
Acceptance checks the running container's exact approved mounts, its environment
against the reviewed image, directory readability and a refused write. It also
checks that the base has no `/inputs`. Team-image CI exercises both forms and
checks missing-source startup failure without host-path creation, using a
synthetic input directory readable by the agent group and a private outbox
subdirectory, with no publisher credentials. Credential scans cover these trees
as the agent, since root without DAC capabilities cannot read their private
subdirectories.

The input folder is ambient to the container's trust group: every agent in the
container can read everything in it. If only one agent may read an input, that
agent needs its own container. Publication happens at a connector or job boundary
outside the agent container. Publisher credentials stay outside it too. This fragment
provides a generic bind only; provider authorization and publication are separate
integration concerns.

For an export queue, the operator provisions `TEAM_OUTBOX_DIR` under an
operator-owned parent, with ownership `AGENT_UID:TEAM_OUTBOX_GID` and mode
2750 (setgid). Keep its resolved source separate from `/state`, optional
`/work`, and all read-only input sources. Supply a dedicated non-root numeric
`TEAM_OUTBOX_GID` distinct from `AGENT_GID` and append
`-f container/agent/compose.agent.outbox.yaml` to both Compose commands.
For example, with both optional folders:

```sh
TEAM_INPUT_DIR=/srv/example-team/inputs \
TEAM_OUTBOX_DIR=/srv/example-team/outbox TEAM_OUTBOX_GID=20002 \
  docker compose -p "oats-team-${TEAM}" --env-file <plain-env-file> \
  -f compose.yaml -f container/agent/compose.agent.yaml \
  -f container/agent/compose.agent.inputs.yaml \
  -f container/agent/compose.agent.outbox.yaml up -d
```

The outbox fragment adds only a read/write `/outbox` bind and its numeric
supplementary group; it does not alter `/state` or the entrypoint's umask
077. Files inherit the directory's outbox group. The integrations submit
helper makes reports and manifests 0640; OATS does not set publication modes.
Acceptance creates and removes its own probe, checks its group, and checks
that `/state` remains 0700. CI also checks that the base has no `/outbox`
and that a missing source fails startup without creating a host directory.
Omit the fragment and unset both outbox variables when no queue is needed.

The outbox is an export queue, not an isolation boundary: every agent in the
container can write and read it. Durable work stays in `/state`. The publisher
reads the outbox read-only in its own namespace; the publisher and its ledger
are outside OATS. No publisher mount or credentials are added to the agent
container. The exact approved writable binds are `/state`, optional `/work`
and optional `/outbox`.

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

Before it copies or locks anything, the spawn checks five things, and
refuses the seat with its fix when one is missing:

- `signing.key`, the member's key;
- the server: `aweb_url` in `workspace.yaml` (`aw workspace connect` writes
  it). The seat's service comes only from there: `OATS_AWEB_URL` is not read;
- the team: the deployment's default team, or else the active team in
  `teams.yaml`;
- `teams.yaml` itself;
- a membership of that team in `teams.yaml`, matched as aw matches it. When
  there is none, accept the team's invite (`aw id team accept-invite`) or
  fetch its certificate (`aw id team fetch-cert`) in the seat's directory, or
  make the seat's team the deployment's default.

The member's certificate file under `team-certs/` is not checked at that
point, and the seat does not work without it: the spawn copies the seat,
fails when it connects or reads the identity back, and removes the copy.

One seat serves one instance at a time. The spawn writes
`.aw-retained-seat.json` beside the seat's `.aw` and refuses a second spawn
while the first instance's home exists; retiring that instance releases the
seat. Every change of that lock is one guarded step, using two private files
beside it, `.aw-retained-seat.json.guard` and `.aw-retained-seat.json.held`.
A change that was killed can leave one of them behind. The next spawn or
take-over then refuses, naming the file and its fix, and the next retire
reports it. Nothing removes such a file automatically. Two cases need the
operator:

- **The holder's home exists and its runtime is known to be dead.** Spawn
  with `identity.takeOver=true`. If that runtime is in fact alive, there are
  then two seats with one key; stop the old one.
- **The holder's home is not on this host** (a home removed by hand, a volume
  restored, or a home on another host that shares the seat). The spawn
  refuses, naming the holder as the lock records it (instance, host, since
  and home) and the release. A lock is never released by age. Once that seat
  is confirmed gone, spawn with `identity.takeOver=true`, which clears the lock
  with a warning, or remove the lock file the refusal names.

Retiring never revokes the member's certificate: on a server that is not the
hosted service, whoever holds the controller key removes a member
(`aw id team remove-member`). A seat's spawn that fails or is killed never
deletes the standing identity's workspace at the server: its retire releases
the lock and prints the `aw workspace connect` that binds the identity back to
its seat.

The pinned OATS release supports this file-backed launch configuration:

```yaml
launch-configs:
  team-claude:
    harness: claude
    env:
      CLAUDE_CONFIG_DIR: /state/home/.claude
      CLAUDE_CODE_OAUTH_TOKEN:
        fromFile: /etc/agent-login/claude-token
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      DISABLE_UPDATES: "1"
      DISABLE_FEEDBACK_COMMAND: "1"
      ENABLE_CLAUDEAI_MCP_SERVERS: "false"
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1"
```

Select it with `--launch-config team-claude`. The operator provisions only a
`claude setup-token` result through the supported token route. It is readable
by every agent in the same trust group; read-only mounting does not hide it
or narrow its authority. Never share the mount across trust groups.

For the optional external model role, the wrapper also writes
`{"skipWebFetchPreflight": true}` into `/state/home/.claude/settings.json`,
merging with any other supported settings. The literals above disable ancillary
Claude traffic; they do not prove that the pinned harness needs only
`api.anthropic.com`. Qualify a real authorized start and turn, retaining every
refused DNS/SNI name. Report an additional necessary host rather than adding it
automatically. Do not put `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` alongside
this login: those credentials take precedence over the setup-token input.

The [egress component](../container/agent/egress/README.md#optional-external-source-and-model-roles)
defines the two optional source/model routes and their operator-selected DNS
resolvers, and the [external roles a deployment names](../container/agent/egress/README.md#deployment-named-external-roles)
(up to 16 roles in all, each an exact public origin, such as a mail group's
`https://graph.microsoft.com`). A policy whose services are all hosted elsewhere
declares only external roles ([hosted services](../container/agent/egress/README.md#hosted-services)).
Their boundary is exact SNI and a validated public destination;
it does not filter repository paths, HTTP authorities or data sent to a provider.
It limits which services are reachable, not which accounts on them. A credential
from any source, including an untrusted message, can allow an agent to push data
to a GitHub repository or send data to a model account controlled by that
credential's owner. Publishing needs a separate operator decision and a push
credential scoped to one repository; the network boundary does not enforce
that scope.

Direct source access is off by default. Operator-refreshed read-only mirrors
provide source reads without that outbound route. They avoid access to any
public GitHub repository, request-path disclosure in GitHub logs, and writes
limited only by credential scope. Mirrors reflect the last operator refresh;
direct access uses the configured remote source. Both routes remain supported.
The resolver input requires public IPv4 DNS and proxy UDP/TCP 53 access to it;
a cluster that mandates a private DNS resolver is not supported by this input.
The existing five-service ingress audit remains a separate admission gate.

### A knowledge credential

Agents that propose knowledge with `oats.okf` need a GitHub credential of
their own, never the maintainer's: whatever it may do, every agent in the
container may do. Give them an identity with the write role only on the
knowledge repository, its token in a file named by
`settings.oats.okf.github-token-file`, and keep the identity that merges to
the accepted branch outside the container. oats.okf's
[Bringing up a deployment's knowledge store](https://github.com/oats-project/oats-okf/blob/v6.3.0/README.md#bringing-up-a-deployments-knowledge-store)
(oats.okf 6.2 and later) has each step; run its
`oats okf setup --check` in the container to check them.

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
  the agents. Then it stops sshd and the broker in parallel, allowing sshd three seconds
  and the broker six seconds before escalation. The broker budget preserves
  its channel children's five-second delivery drain. A declared child is
  stopped in that same step, with its declared `stopMs` (at most eight
  seconds), so it runs until host run has stopped the agents. A broker or
  host-run exit is reported and drains the other children before a nonzero
  container exit, so
  the restart policy can restart it. The broker runs as the agent uid; its
  default state directory is `/state/home/.config/aw/wake`, so registrations
  survive container replacement and it starts again even with no spawn.
- **`stop_grace_period: 50s`** in the Compose service. Docker's default
  10 seconds is shorter than the kernel and broker drains; each harness
  alone gets 20 seconds. A container killed at the timeout leaves agents
  that were not stopped in order. A platform that does not read the Compose
  file needs the same stop timeout in its container spec. The 50-second
  limit is the runtime's final failure boundary for stuck OS work; wake
  delivery and model activity require separate evidence.
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

<!-- docs/release-notes/v0.69.22.md links here under this section's former
     name, "A bb server for the team": the anchor keeps those links whole. -->
<a id="a-bb-server-for-the-team"></a>
## An optional child

A derived image can add one more supervised process to the team container:
a server its agents use on loopback, say. The base image runs none. The
mechanism has two halves, and they belong to different people:

- **The declaration is the image's.** A derived image holds one file,
  `/etc/agent-child.json`, that says what to run. It is root's file on the
  read-only root, so only an image build can write it.
- **The switch is the deployment's.** The Compose fragment that ships with
  the derived image sets one fixed environment entry,
  `AGENT_CHILD: "<name>"`. Without it nothing starts, and a declaration in
  the image is inert: the supervisor reads no file and runs as it does on the
  base image.

One child, not a list: a second one is a new decision.

The image that runs a [bb](https://github.com/get-bb/bb) server this way,
its relay and its operator docs live in
[oats-project/oats-bb](https://github.com/oats-project/oats-bb); this
repository holds no product's image. bb, the optional child that oats-bb
ships, is documented
[there](https://github.com/oats-project/oats-bb/blob/main/container/README.md):
the threads of one bb can write each other's storage, and bb's sandboxed
modes are not a security boundary. `AGENT_BB`, `container/agent-bb`,
`compose.agent.bb.yaml` and the relay shipped in 0.69.22 as experimental,
with no compatibility promise, and are gone without an alias: a container
that still sets `AGENT_BB` is refused at start with a line naming
`AGENT_CHILD`.

**A child's loopback ports are reachable by every agent in the container.**
Whatever the child serves there, with whatever login it does or does not
ask for, belongs to the container's one trust group
([One team, one trust group](#one-team-one-trust-group)). The service still
publishes no port.

### The declaration

`/etc/agent-child.json` is JSON of at most 16 KiB, with a closed grammar:
every key below is required unless marked, and an unknown key is refused.

```json
{ "name": "example",
  "command": ["/usr/local/bin/example-server", "--bind", "127.0.0.1"],
  "env": { "EXAMPLE_TELEMETRY": "false" },
  "envFromFile": { "EXAMPLE_TOKEN": "/etc/agent-login/example-token" },
  "ready": { "url": "http://127.0.0.1:39000/status", "field": "ready" },
  "listen": [39000],
  "version": { "command": ["/usr/local/bin/example", "--version"], "file": "/opt/agent-child/version" },
  "stopMs": 5000 }
```

| Key | Grammar | Meaning |
| --- | --- | --- |
| `name` | 1 to 20 lowercase letters, digits or dashes; not `broker`, `sshd`, `host-run`, `status` or `supervisor`, the base's own names in the log | What the supervisor's lines call the child, and the value `AGENT_CHILD` must have. |
| `command` | A non-empty array of strings; `command[0]` an absolute path that exists and whose real path is outside `/state`, `/work`, `/tmp`, `/run`, `/outbox` and `/dev/shm` | The child's argv, exactly. No shell. The supervisor resolves `command[0]` once, at start, refuses a file inside a writable mount, and runs that resolved file under its declared name at the start and at every restart, so a link on the way that an agent could re-point is never followed again. |
| `env` | An object of strings; names match `[A-Z_][A-Z0-9_]*` | Literal variables added to the child's environment. May be `{}`. |
| `envFromFile` | Optional. An object of variable name to a file directly under `/etc/agent-login/`; names as for `env`, and no name in both | Variables whose value is the file's content, read once at start ([below](#envfromfile)). |
| `ready.url` | `http://127.0.0.1:<port>/<path>`, the port one of `listen`; the path of letters, digits and `._~/?&=%-` | Where the supervisor asks whether the child is ready. |
| `ready.field` | A letter or underscore, then letters, digits or underscores; at most 64 characters | The top-level field of the JSON answer that must be `true`. |
| `listen` | A non-empty array of distinct ports from 1024 to 65535, without 2222 | The loopback TCP ports the child holds. Acceptance requires each. |
| `version.command` | A non-empty array of strings; `command[0]` an absolute path | A command that prints the child's version. |
| `version.file` | An absolute path | A file the image writes at build time with that same version: one printable line of at most 64 characters, in a file of at most 256 bytes. Acceptance compares the two, so it needs no checkout of the image's repository. |
| `stopMs` | A whole number from 1000 to 8000 | How long the child gets after SIGTERM before SIGKILL. |

Neither `env` nor `envFromFile` may set `PATH`, `HOME`, `LD_PRELOAD`,
`NSS_WRAPPER_PASSWD`, `NSS_WRAPPER_GROUP`, `NODE_OPTIONS` or `AGENT_CHILD`:
the image, the entrypoint and the switch set those.

Nothing else is declarable. The order, the start timeout, the restart policy
and the process group are the base image's
([What the supervisor does](#what-the-supervisor-does)).

### envFromFile

One rule for every entry. The supervisor reads each file once, before any
child starts:

- **No such file:** the child starts without that variable, even when the
  supervisor's own environment holds one of that name: an `envFromFile`
  name comes from its file or not at all.
- **Empty after trimming:** the same, with one line that names the variable.
- **Any other read error:** the start is refused.
- **Whitespace or a NUL byte inside the trimmed value** (a second line, a
  space, a tab, a file saved as UTF-16):
  the start is refused with `the file for <VARIABLE> must hold its value on
  one line`. A file with two lines is never passed on in part.

The value reaches the declared child's environment and nothing else: no
line the supervisor writes, no argument, no other child. The child reads its
environment when it starts, so after replacing a file under the login mount,
restart the container ([After changing a credential](#after-changing-a-credential)).
Every agent can already read the login mount.

### What the supervisor does

With `AGENT_CHILD` set, the supervisor reads the declaration once, before
any child, and then:

1. Starts the wake broker and waits for it, as on the base image.
2. Asks `ready.url` once, for at most a second. Whatever accepts that
   connection before the child exists is another process, whether it answers
   ready, not ready or nothing, and refuses the start. A refused connection
   is the only pass: an attempt that cannot tell whether anybody listens
   refuses the start too.
3. Starts the child: the resolved `command[0]` with argv exactly `command`,
   the supervisor's own environment without the `envFromFile` names, plus
   `env`, plus the `envFromFile` values that were read, in a process group
   of its own.
4. Asks `ready.url` until it answers 200 with JSON whose top-level
   `ready.field` is `true` while the child it started is still alive, for up
   to 30 seconds. It then writes `agent-supervisor: <name> ready (<field>:
   true)`.
5. Starts sshd and `oats host run`.

On SIGTERM, host run goes first, and the child keeps running while host run
stops the agents. Then sshd, the broker and the child are stopped side by
side; the child gets SIGTERM and `stopMs` before SIGKILL.

The stop budget holds for whatever an image declares, since `stopMs` is
capped: at most 35 seconds for host run (10 + 5 + 20), then the slowest of
sshd (3 seconds), the broker (6) and the child (at most 8), 43 seconds in
all inside the 50-second stop grace. `test/agent-container.test.mjs` pins
that sum against the supervisor's exported budgets, the cap and the Compose
file, with 5 seconds to spare.

### When it fails

Each refusal at start is one fixed line on standard error, exit 1, before
any child starts. A line names the key at fault and never a value from the
file.

- **`AGENT_CHILD` on an image without a declaration**, the base image
  included: `AGENT_CHILD needs an image that declares a child in
  /etc/agent-child.json`. Select the derived image with `AGENT_IMAGE`.
- **A declaration that is not the image's own file:** a symlink, not a
  regular file, not owned by uid 0, or writable by its group or by others.
  Over 16 KiB, or not JSON, is refused too. The supervisor runs as the
  agent, so the file must be readable by everyone (mode 0644 or 0444): one
  it cannot open is refused with `/etc/agent-child.json could not be read
  (<code>)`.
- **A declaration outside the grammar:** `/etc/agent-child.json: <key>
  <what it must be>`, for an unknown or missing key and for every value the
  table above rules out.
- **A `name` that differs from `AGENT_CHILD`.** The fragment and the image
  must be the same product's.
- **A command that does not exist, or resolves under a writable mount.**
- **An `envFromFile` file that cannot be read, or holds whitespace inside
  its value** ([above](#envfromfile)).
- **`AGENT_BB` set to anything:** `AGENT_BB is gone: use an image that
  declares its child and AGENT_CHILD (the bb image now lives in
  oats-project/oats-bb)`.
- **The child is not ready.** A child that exits before it is ready, 30
  seconds without a ready answer (one that arrives later does not count), or
  anything listening on `ready.url` before the child starts
  fails the container start: neither sshd nor host run starts, the exit is
  nonzero and the restart policy starts the container again.
- **The child ends later.** That is not a container failure. The supervisor
  writes `agent-supervisor: <name> exited (<code or signal>)`, sends SIGKILL
  to what is left of the child's process group, and starts the child again
  after 1 second, doubling to 60 seconds, and from 1 second again once a
  child has stayed up five minutes. sshd, the broker, host run and the
  agents keep running.
- **Stopping.** A child that had to be killed after `stopMs`, or that ended
  while host run was still stopping agents, makes the stop a failed one. A
  restart that was pending at SIGTERM starts no further child.

### Limits

The child counts toward the container's limits. A derived image's docs say
what to add to `AGENT_MEMORY` and `AGENT_PIDS` for it.

### What was run

Run on amd64, in the base image and a fixture derived image
(`test/fixtures/agent-child`) under the Compose flags: the build, the child
ready at start between the broker and sshd, a restart after `kill` and after
`kill -9`, the ordered `docker stop`, and acceptance with and without
`AGENT_CHILD`. **NOT RUN:** arm64; any real product's image, which its own
repository proves.

## Acceptance and evidence

The host needs Docker and Node 22.13+ on 22.x, 23.4+ on 23.x, or a newer
major. Export the same plain variables used for Compose, then run:

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
and the single network/address. With `AGENT_CHILD=<name>` exported it admits
that one environment entry and reads `/etc/agent-child.json` from the
running container. It requires the file to be a regular file owned by root,
not a symlink and not writable by its group, by others or by the agent, to
pass the supervisor's grammar and to declare that name. It reads the
container's listening TCP sockets and requires every declared `listen` port
on loopback and nothing beyond loopback except sshd's port 2222. It runs
`version.command` in the container, requires its output to equal the
trimmed content of `version.file`, and reports that version. Without
`AGENT_CHILD`, a container that has it set is refused. A container that has
`AGENT_BB`, or an image that sets `AGENT_CHILD` itself, is refused either
way. The stop timeout must be 50 seconds and the
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
  manual-only; enabling automatic packed-image PR verification is separate work.
  Ordinary PR verification keeps the committed context in the meantime.
  An incompatible baseline fails explicitly, with no registry-kernel fallback
  and no wider lock allowance. The committed baseline pins OATS 0.70.7 and
  aw 1.36.59, meets the final OATS 0.69.18+/aw 1.36.59+ floor with its exact
  runtime closure, and passes the strict baseline guards.
  Positive real packed-image acceptance remains
  **NOT RUN** until the manual job runs successfully at this head.

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
`/opt/oats-build-inputs`; packing adds no tarball COPY, kernel-selection build
argument, lifecycle execution or runtime mount. The deploy inventory separately
requires the source-SHA build argument. The registry release context and its
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

The same job then proves the optional child with a fixture derived image,
`test/fixtures/agent-child`: a dependency-free Node HTTP server on one
loopback port, its declaration and its version file. It builds that image
from the image it just accepted, with no registry in between, and runs the
same fixture and the same unmodified acceptance once more with
`AGENT_CHILD` set: alone, then with the inputs and the outbox fragments. It
also requires acceptance without `AGENT_CHILD` to refuse that container.
The fixture is outside `container/agent`, so it is never in the base
image's build context, and it is not exported or published.

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
profile when signer is declared. An optional derived `roles` array selects a
nonempty subset of aweb, logs, registry, secrets and signer, with exactly matching
targets and probe paths. Omission retains the five-role policy and output.
`humanRole` optionally names the human ingress anchor: `"signer"` or `"secrets"`.
Absent or `"signer"` retains the signer rule, requiring `humanOrigin` with signer.
`humanRole: "secrets"` requires declared `roles` including secrets and excluding
signer, plus `humanOrigin`. Selecting Secrets while declaring signer is refused.
Without signer or
an explicit Secrets anchor, `humanOrigin` is refused; it is never routed or
external. Existing deployments change nothing. A bundle setting `humanRole`
needs the new egress image, since older images refuse the field. Registry
`authorityRecords` are required with registry and, unless the policy declares
external roles, refused without it, independently
of signer: messaging-only namespaces still need exact `_awid` TXT evidence for
discovery and sender verification. The root-authoritative resolver has no
forwarding fallback. The proxy permits only the named API and registry routes and serves
only the declared public namespace authority records. Service custody keys,
PostgreSQL, Redis and the Docker socket stay outside the agent container.

Network membership, CNI enforcement and ingress Host/SNI agreement require runtime
proof before launching agents. An internal bridge, a NetworkPolicy object or a
healthy proxy alone does not prove the boundary. The [service descriptor](../container/agent/egress/descriptor.md)
supplies the wrapper mapping without a separate operator schema.

The [minimal Compose wrapper and refusing network preflight](../container/agent/egress/README.md#minimal-compose-wrapper-and-network-preflight)
own explicit agents/services IPAM, gateways, `AGENT_IP` and `EGRESS_ADDRESS`.
Preflight is read-only on the Linux engine host and refuses failed observations
or CIDR overlaps across every Docker IPAM entry, route table and link address.
Every role set keeps unlisted DNS/TLS refusal, alternate-network refusal, a live
host-gateway canary, direct upstream/backend denial and an explicit IPv4 IPAM
gateway. The report separates universal and declared controls. The Compose probe
accepts an optional derived `namePrefix` for its temporary containers and reports
`{name,image,network,created,absentVerified}` receipts on success and refusal.
Cleanup removes only an exact name whose per-attempt ownership label matches;
timeouts require inspection and never count as absence. A failed observation
refuses and reports the unverified name. The new `--json` mode returns
`{passed,receipts,error?}` on stdout, with exit 1 on refusal; the default PASS token
and stderr receipt lines remain available. See the
[Compose probe contract](../container/agent/egress/README.md#boundary-probe-on-an-existing-compose-deployment).
Stage public
sources before credentials; there is no codeload exception. Pin wrapper,
compiler/proxy image and probes to one reviewed commit and retain image digests.

The ingress probe keeps backend non-delivery witnesses for owned routes. A
wrapper may explicitly mark only the registry as external for verified-TLS 200
controls, without third-party refusal or backend-log claims. When signer is
declared, signer and human-surface ingress controls remain required. A Secrets
anchor instead proves the Secrets API and console ingress, even when they share
one backend and log. `--request-origin` and its pinned address name that anchor;
the compatible request path/log must match its audit entry. Forbidden tags must
be absent from every owned backend log, even if a backend returns 421 itself.
The ingress control report and boundary report name the anchor; runtime role
controls retain the compiler's canonical order. A policy without signer or an
explicit Secrets anchor cannot invoke ingress admission.
Deployment bundles default `team.registryRoute` to `external`; existing bundles serving a local registry
must select `local` and refuse a URL their service does not serve. See the
[route-mode contract](../container/agent/egress/README.md#ingress-admission-probe)
for the exact probe inputs and ownership checks.

For Kubernetes, liveness runs `node /usr/local/lib/agent-liveness.mjs` to check
the supervisor process. SSH on port 2222 is readiness: losing SSH must not
restart the whole team while its agents and broker are still running. The
container's 50-second termination window covers the kernel and supervisor
phases under the same [shutdown failure boundary](#the-kernels-periodic-work).
