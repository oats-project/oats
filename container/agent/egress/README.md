# Agent egress component

This image runs authoritative CoreDNS and an NGINX stream TLS forwarder. Agents
resolve approved service names to the proxy and reach only its DNS and TLS ports.
TLS stays end to end. The shared deployment wrapper owns operator configuration,
network creation, the ingress and the policy file; this component defines no
second operator schema.

## Derived policy

The wrapper mounts a non-secret JSON file read-only at `/etc/egress/policy.json`.
With external roles disabled, its field set is:

```json
{
  "frontAddress": "172.30.0.2",
  "privateIngressAddresses": ["10.20.0.10"],
  "deniedAddresses": ["10.20.0.11", "10.20.0.12"],
  "humanOrigin": "https://approve.example.invalid",
  "authorityRecords": [
    {"name": "_awid.team.example.invalid", "text": "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}
  ],
  "targets": {
    "aweb": {"origin": "https://aweb.example.invalid", "addresses": ["10.20.0.10"]},
    "secrets": {"origin": "https://secrets.example.invalid", "addresses": ["10.20.0.10"]},
    "logs": {"origin": "https://logs.example.invalid", "addresses": ["10.20.0.10"]},
    "signer": {"origin": "https://prepare.example.invalid", "addresses": ["10.20.0.10"]},
    "registry": {"origin": "https://registry.example.invalid", "addresses": ["10.20.0.10"]}
  }
}
```

Without `roles`, `targets` contains exactly those five roles; compilation and
route order remain unchanged. An optional `roles` array declares a nonempty
subset of `aweb`, `logs`, `registry`, `secrets` and `signer`. Order does not affect
route indexes. Missing targets, undeclared targets, unknown/duplicate roles and
extra policy fields are refused. Do not invent stand-in services.

For example, a messaging-only derived policy is:

```json
{
  "roles": ["aweb", "registry"],
  "frontAddress": "172.30.0.2",
  "privateIngressAddresses": ["10.20.0.10"],
  "deniedAddresses": ["10.20.0.11", "10.20.0.12"],
  "authorityRecords": [
    {"name": "_awid.team.example.invalid", "text": "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}
  ],
  "targets": {
    "aweb": {"origin": "https://aweb.example.invalid", "addresses": ["10.20.0.10"]},
    "registry": {"origin": "https://registry.example.invalid", "addresses": ["10.20.0.10"]}
  }
}
```

`humanRole` is optional and closed to `"signer" | "secrets"`. Absent or
`"signer"` keeps the existing signer anchor: signer must be declared whenever
`humanOrigin` is present, and signer requires `humanOrigin`. With
`humanRole: "secrets"`, `roles` must be declared, include `secrets`, exclude
`signer`, and supply `humanOrigin`. Selecting Secrets while declaring signer is refused; the probe
never guesses one from the role set. Without signer or an explicit Secrets
anchor, `humanOrigin` is refused. It is never a routed or external hostname.
The new field changes no zone, Corefile or nginx bytes for existing policies.
A bundle setting `humanRole` must use the new egress image; older images refuse
that field. Existing deployments need change nothing.
`authorityRecords` is required with registry and refused without registry,
independently of signer. The full default keeps both fields. Namespace authority
is needed for registry discovery and sender verification in messaging-only
deployments too: this resolver is authoritative for the root and has no
forwarding fallback for `_awid.<domain>`. A subset without signer uses its
provisioned registry authorities and needs no invented signer service.
Adding Secrets requires adding `secrets` to both
`roles` and `targets`, with its actual origin and pinned address.

Origins are exact HTTPS DNS origins
on port 443. Addresses are pinned IPv4 literals resolved and checked before the
proxy starts. Private ingress addresses need explicit exceptions; loopback,
metadata and reserved addresses remain denied. `deniedAddresses` lists protected
backend addresses, including PostgreSQL and Redis, and overrides exceptions.
Declared upstreams never use live DNS. The agent-facing DNS is authoritative,
not a general recursive resolver.

### Optional external source and model roles

The wrapper's `egress.external.source` and `.model` booleans enable exactly
`https://github.com` and `https://api.anthropic.com`, respectively. Both default
false. The operator does not supply arbitrary origins. When either is enabled,
the wrapper adds these derived fields, omitting disabled roles:

```json
{
  "externalTargets": {
    "model": {"origin": "https://api.anthropic.com"},
    "source": {"origin": "https://github.com"}
  },
  "externalResolverAddresses": ["1.1.1.1"]
}
```

`egress.external.resolvers` supplies 1–4 distinct public IPv4 DNS resolver
addresses, in operator order, with no default. The proxy must reach those public
resolvers on UDP/TCP port 53; a cluster that requires its private DNS resolver
is not supported by this input. Resolver validation and per-answer destination
validation are separate checks; the public-resolver restriction is part of this
configuration contract.
Both derived fields are absent with neither role enabled. The component checks
the exact roles, origins and resolver addresses again. No knowledge-publication
role, npm, codeload, raw-file or release-asset host is included.

Agents resolve configured external names to the proxy address. Only the
proxy resolves their upstream addresses, for each new connection. An
image-owned loopback connector validates every returned IPv4 address, rejects
mixed safe/unsafe answers, and connects to the selected IP literal without a
second lookup. Only the first validated answer is tried; an unreachable first
address fails that connection without trying the remaining answers.
Private, loopback, link-local, reserved and denied addresses,
the proxy, private-ingress exceptions and every pinned deployment target are
excluded. External routes never inherit internal private-ingress exceptions.
DNS and connect work has a five-second bound; there is no default upstream,
recursive agent DNS, CONNECT endpoint or automatic host expansion.
Client cancellation aborts pending work without being logged as a destination
refusal; actual resolution and connection refusals remain role-labelled.

The external guarantee is exact declared SNI plus a validated public
destination. TLS stays end to end. It does not filter encrypted HTTP
Host/`:authority`, paths, methods or repositories. Source access can read any
public repository on the allowed host; request paths and queries can disclose
data. Absence of a provisioned Git credential is not a network prohibition on
introducing one. The boundary limits reachable services, not accounts on those
services. A credential introduced through any source, including an untrusted
message, can authorize a Git push or send data to a model account its owner
controls. Publishing is a separate operator decision; any authorized push
credential must be scoped to one repository. Provider requests can contain
prompts, decrypted messages, files and tool output.

With external roles configured, CoreDNS logs denied questions and nginx logs
refused SNI names. The connector reports refusal by role without request bodies,
credentials or resolved values. A real harness start and turn must retain all
refused names; another required host is a finding, not permission to add it.

Healthchecks also appear in these logs: each check deliberately asks DNS for
`denied-<uuid>.invalid` and opens the TLS port without sending a ClientHello,
producing an empty-SNI refusal. Keep the raw qualification capture, but classify
these recognisable health entries separately when reporting the harness's host
requirements. A matching name or empty SNI alone does not identify its producer;
correlate healthcheck activity before excluding an entry from that report.
With the five-second Compose interval they recur continuously;
the operator must bound log retention in its logging driver or collector.
An empty SNI entry does not identify another host the harness needs.

The runtime body checks each enabled external name resolves only to the proxy
and receives an ordinary 2xx–4xx HTTP response over verified TLS, without following
redirects. External controls stop at response headers, so a large homepage body
does not fail connectivity. Internal readiness controls retain their response
size bound. An explicit probe CA extends the process's default roots, including
its environment-added certificates, using the shipped Node's
[default CA store](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsgetcacertificatestype).
These are connectivity controls, not readiness or public-backend
non-delivery evidence. Owned DNS/TLS mutants and shipped-client checks qualify
external enforcement separately from the five-service common-audit proof below.
Direct source access is off by default. Operator-refreshed read-only mirrors
provide source reads without enabling the outbound source route. They avoid
opening all public repositories on GitHub, disclosure through request paths in
GitHub logs, and writes whose only restriction is the credential's scope.
Mirrors observe the last operator refresh; direct source access observes the
remote source through the configured route. Neither route is a general default
preference.

The nginx worker has a shared ceiling of 256 connections, counting client and
upstream connections across internal and external routes. Long-lived model
streams consume that pool; it is not a qualified agent-capacity figure.

After building the proxy, explicit public-host QA runs as:

```sh
sh test/agent-external-egress-image.sh <proxy-image-id> <existing-agent-image-id>
```

This fixture creates its own internal isolated agents network and services
bridge, uses the agent image's shipped Node and Git without starting its broker,
and checks public HTTPS through the runtime body's shared serialized transport,
with an unrelated fixture CA added to the default trust store. It also checks
Git `ls-remote`, undeclared DNS/SNI refusal and refusal
logs. It selects `1.1.1.1` and `8.8.8.8` only for that disposable fixture. It
contains no login, seat or model request and removes its own resources. Set
`EGRESS_EXTERNAL_EVIDENCE` to retain the proxy log. Run the original
`test/agent-egress-image.sh` separately for the five-service baseline and the
plain-versus-isolated gateway regression. Neither fixture proves a model turn,
verified wake, the actual deployment boundary or Kubernetes enforcement.

When registry is declared, the wrapper supplies `authorityRecords` from the
existing provisioned public namespace authorities, using the existing AWID TXT
encoding/parser and registry-origin/profile binding against `team.registryUrl`.
These authorities are not a signer dependency. Where a signer profile supplies
the material, keep its validated `namespace_authorities`, `registry_origin` and
configured signer-origin checks; reduced sets still require the registry's
provisioned authority material without inventing a signer profile or service. Each
`name` is the exact `_awid.<domain>` owner name, without a trailing dot; `text`
is the complete existing AWID record, without zone-file quotes. This component
serializes those public records into the authoritative zone. It does not invent
namespace controllers or change the AWID verification protocol. Unknown names
receive negative answers. Controller rotation follows the same profile update.

## Network and ingress contract

The top-level Compose service extends `compose.egress.yaml` and supplies:

| Variable | Meaning |
| --- | --- |
| `EGRESS_IMAGE` | Built proxy image by digest. |
| `EGRESS_POLICY_FILE` | Absolute path to the derived JSON file. |
| `EGRESS_ADDRESS` | Static proxy address on the internal `agents` network. |

The bundle defines the networks. Only agents and this proxy join `agents`, which
is IPv4 and internal, with
`driver_opts: {com.docker.network.bridge.gateway_mode_ipv4: isolated}` (Docker
Engine 28 or later). An ordinary internal bridge still exposes its host gateway;
the isolated mode removes that host bridge address. Only the proxy joins both
`agents` and `services`; IP
forwarding is disabled. The agent has no other bridge, host networking, elevated
capability, engine socket, service-key or database mount. Its existing harness
login stays the dedicated read-only `/etc/agent-login` mount.

### Minimal Compose wrapper and network preflight

[`compose.minimal.yaml`](compose.minimal.yaml) extends the existing agent and
proxy services and owns both networks' explicit IPAM. It consumes
`AGENTS_SUBNET`, `AGENTS_GATEWAY`, `AGENT_IP`, `EGRESS_ADDRESS`,
`SERVICES_SUBNET` and `SERVICES_GATEWAY` together. The agent subnet is internal,
IPv4-only and uses isolated gateway mode; the proxy alone connects it to
`services`. The preflight requires private IPv4 network CIDRs with at least
eight addresses, distinct usable endpoints and disjoint agent/services ranges.
Do not overlay an extra agent network or replace isolated mode.

Every deployment that creates its own agents/services networks runs this
preflight, including wrappers other than the minimal example. From the extracted
egress directory, use `node egress/preflight-network.mjs`. On the
**Linux Docker engine host**, choose candidate values and run the
read-only preflight immediately before network creation. These are fictional
candidate ranges, not defaults or an allocation recommendation:

```sh
export AGENTS_SUBNET=172.27.90.0/24 AGENTS_GATEWAY=172.27.90.1
export AGENT_IP=172.27.90.3 EGRESS_ADDRESS=172.27.90.2
export SERVICES_SUBNET=172.27.91.0/24 SERVICES_GATEWAY=172.27.91.1
node container/agent/egress/preflight-network.mjs > admitted-network.env
```

Require exit 0 before consuming that file or creating networks. Failure leaves
no admitted assignments; never source it after a failed command. The preflight
prints only those six validated assignments. It inspects the selected local
Unix-socket Docker context, every listed network and every IPAM entry, all IPv4
route tables, and all link addresses (`ip -j address show`). It refuses any
failed command, unreadable/malformed observation, endpoint conflict or CIDR
overlap, including a second Docker IPAM range or a VPN link. A default route is
reachability, not an assigned range; every more-specific route remains a veto.
IPv6 IPAM/link entries are validated but cannot overlap these IPv4 ranges.
Remote contexts and Docker connection overrides are refused: host observations
must describe the engine host. No network, route, link or Docker setting is
changed. This is a point-in-time check, not an allocator or a reservation; rerun
if host networking changes before creation.

The surrounding deployment wrapper supplies the existing agent-service inputs
(`TEAM`, pinned `AGENT_IMAGE`, resource limits and absolute state/login/public
SSH/resolver paths), `AGENTS_NETWORK`, `SERVICES_NETWORK`, pinned `EGRESS_IMAGE`
and `EGRESS_POLICY_FILE`. Use the admitted `EGRESS_ADDRESS` in both the policy's
`frontAddress` and the read-only `resolv.conf`. Render with:

```sh
docker compose --env-file admitted-network.env \
  -f container/agent/egress/compose.minimal.yaml config --quiet
```

Before starting a real agent, the deployment wrapper stages the credential-free
`sleep infinity` probe described below using this same service/network layout,
then requires the boundary PASS and any applicable ingress admission proof.
The minimal file provides no application services or provisioning automation;
the wrapper supplies the declared APIs on `services` and their live controls.
It must not launch the normal agent entrypoint merely to test networking.

Stage public source checkouts or refresh read-only mirrors **before introducing
credentials**. There is no codeload, raw-file, release-asset or other source-fetch
exception to obtain them later. Retain one reviewed source commit for the
policy compiler/proxy build, this wrapper and the probe, plus the resulting
proxy and agent image digests and control reports. Do not mix a released proxy
with an unreviewed wrapper/probe checkout. Agent and egress manifests must have
the same source commit and identical hashes for every shared deploy file;
a consumer refuses a mixed-source pair even when both images verify separately.

Kubernetes uses the same image and derived policy. An enforcing CNI must restrict
agent egress to proxy TCP/UDP 53 and TCP 443, and proxy egress to the pinned TLS
ingress addresses on TCP 443. An installed NetworkPolicy object alone does not
prove enforcement. The agent must have no service credentials or backend access.
External roles also need proxy-only access to the selected DNS resolvers and
validated public TLS destinations. Those destination addresses are dynamic, so
a Kubernetes egress policy cannot use the internal routes' pinned-address list
for them: it must permit public TCP 443, with the external hostname and
per-answer address restrictions enforced by the connector. Kubernetes
adapter/CNI qualification remains separate from the Compose component proof.

**An SNI map does not enforce HTTP origins.** Before enabling the human
anchor's API route (signer by default, or explicit Secrets),
the TLS ingress must reject mismatched SNI and HTTP Host, including HTTP/2
`:authority`, before routing. The runtime journey must show that allowed request
SNI with the excluded human Host/authority cannot reach the human service, that
matched traffic succeeds, and that unknown or absent SNI has no default route.
If this cannot be proved, keep the anchor's API route closed and use isolated ingress
listeners or upstreams. Exact authority and port comparisons are required.

## Ingress admission probe

Both wrappers run the same probe from services-side connectivity before admitting
agents. Capture all actual service and human backend access logs first; the logs
must include request query strings. Do not use the TLS frontend access log as
proof that a backend received nothing.

```sh
node /opt/egress/probe-ingress.mjs \
  --address <ingress-ipv4> \
  --request-origin https://prepare.example.invalid \
  --human-origin https://approve.example.invalid \
  --human-log <human-backend-log> \
  --ca-file <public-ca.pem> \
  --human-path /handoff-assets/handoff.css \
  --audit-path /ready \
  --policy <derived-policy.json> \
  --route-logs <runtime-audit.json>
```

The files are operator-side probe inputs; never mount backend logs into an agent.
Log entries may name one file when surfaces share a backend process. Choose
an existing, harmless endpoint returning 200 for each route in `--route-logs`;
`--human-path` names the human surface. These matched service controls must
return 200 at their existing paths, including the human CSS route.
Certificate chain and service-name checks stay on.
Without `--ca-file`, Node's normal trust configuration applies.

`--audit-path` declares one common path whose request tags every owned backend can
witness, such as `/ready` with health-only service logging. Before and after the
negatives, separate matched-SNI/Host coverage controls call this path on every
local role/address and the human surface over HTTP/1.1 and HTTP/2. Coverage controls
require verified TLS, an ordinary 2xx–4xx response and their tags in the
appropriate backend logs. A 404 on this extra control can demonstrate logging;
it never replaces a valid 200 service or human control. Redirects are observed
without following another destination. A missing witness, TLS error, timeout or
5xx fails qualification.

All forbidden cases use that same witnessed audit path, so a cross-route
misdelivery remains visible even to a backend that logs health paths only.
The probe sends matched controls and forbidden authorities over HTTP/1.1 and
HTTP/2. It includes the human host, explicit port 443, a wrong port, a hostname
suffix, unknown SNI and absent SNI. Only 421 or specific connection/TLS refusals
count as rejections; known-SNI transport refusals require completed TLS and no
HTTP response. A pre-TLS reset cannot prove a Host/authority check. A timeout or
certificate-validation error fails. A peer
`internal_error` alert is accepted only before TLS completes and before any HTTP
response, and only for the enumerated unknown/absent-SNI cases. The same alert
fails for known SNI or a matched control. Unique
query tags for matched controls on owned routes must appear in the appropriate
backend log, and all forbidden tags must be absent from every supplied log.
Final matched controls and common-path coverage on each local route/address
and the human surface provide
later log records after the negative cases. Responses and log contents
are never printed. Success prints exactly `OATS_EGRESS_INGRESS_PASS`; require
that token and exit 0 before enabling the anchor's API route and admitting agents.
On success stderr names the proved anchor as `egress: human anchor: signer` or
`egress: human anchor: secrets`; retain it with the token.

The CLI requires `--policy <derived-policy.json>` and
`--route-logs <runtime-audit.json>` and `--audit-path <common-path>` together;
a partial signer-only call or missing audit path fails
without an admission token. Signer policies and policies with `humanRole: "secrets"`
use this additional ingress proof. Other policies without signer do not invoke
this admission CLI; the exported `probeIngress` routine refuses them with
`ingress admission requires the signer role` before sending any controls.
The packaged CLI retains its fixed values-withheld failure diagnostic. The latter file
has exactly the policy's declared role
keys. Local entries hold `{ "path": "/ready", "log": "/logs/aweb.log" }` for that
role's harmless 200 endpoint and actual backend log. Use signer `/readyz` and
registry `/health` where those are the supported routes; `--human-path` and
`--human-log` still name the human surface. Begin capturing every owned backend before
the call. The policy supplies all origins and pinned addresses; it is not copied
into a new operator schema. `--request-origin` must equal the anchor's API origin;
`--address` must be one of its pinned addresses for the human controls. If
supplied, `--request-log` and `--request-path` must equal the anchor's runtime-audit
entry. The Secrets API and console may share one backend and one log; use that
same log for `--human-log` and the Secrets audit entry. A 421 from that backend
still fails when the forbidden query tag reaches any owned backend log.

Only the registry may instead use exactly
`{ "path": "/health", "external": true }`, without a `log` key. The wrapper
must declare ownership; the probe never infers an external route from a missing
log. All other declared roles keep their local log witnesses. Every external
registry address must be disjoint from `--address`, `frontAddress`, private
ingress and denied addresses, and all local-role addresses. Declared pinned
policy targets and optional external source/model roles retain their separate rules.

An external registry receives exactly one matched 200 control per pinned address
and protocol, with certificate and service-name verification. Redirects fail and
are never followed. It receives no common-path coverage, forbidden authorities,
or unknown/absent-SNI probes, and supplies no backend log. This proves only its
positive connectivity, not remote authority refusal or backend non-delivery.
After all obligations pass, the CLI records
`egress: registry external: positive control only; refusal not claimed` on stderr
and the usual admission token on stdout. Retain both streams and the route-mode
input with the result. An external declaration does not relax anchor-SNI/human-
Host refusal, the human 200 control, or any owned backend's log barriers.

The deployment bundle owns `team.registryRoute: external | local`, with
`external` as its default. Existing deployments with a registry Compose service
must set `team.registryRoute: local`; external mode refuses that service or a
deployment-owned registry destination. Local mode must refuse a registry URL
that its registry service does not serve. These ownership checks belong in the
wrapper before this probe runs; the image does not read Compose service
ownership or add another operator schema. For example, a bundle serving its own
registry explicitly declares:

```yaml
team:
  registryRoute: local
```

Full mode tests each local target SNI at each pinned address, over both protocols,
with matched controls and human-authority, wrong-port and suffix refusals.
Unknown/absent SNI is tested per distinct address. Matched tags must reach their
own backend log, including a final matched control after the negatives; no
forbidden tag may reach any supplied backend. The wrappers require this complete
proof before admission. The evidence covers the tested authority/path
combinations, not arbitrary path-dependent forwarding or rewrites. `--ca-file`
adds its public certificates to Node's normal public roots.

## Build and prove

Build from the repository root with
`docker build --build-arg "TEAM_IMAGE_SOURCE_SHA=$(git rev-parse HEAD)" -f container/agent/egress/Dockerfile -t <local-name> container/agent`.
The Dockerfile-specific allowlist admits only runtime and deploy inputs;
`/opt/oats/deploy` preserves the agent/egress hierarchy for extraction without a
checkout (see [Run contract](../../../docs/container.md#run-contract)). The image runs as
10001:10001 with read-only root, dropped capabilities, no new privileges and only
`/tmp` writable. The namespaced unprivileged-port sysctl enables ports 53 and 443
without adding capabilities. Loss of either DNS or TLS child fails the image and
stops its peer. The build removes the upstream CoreDNS file capability so it
can execute with an empty capability bounding set. `node /opt/egress/health.mjs` requires an exact DNS answer, an
NXDOMAIN for an unknown name and a live TLS listener. It is a readiness check.

`test/agent-egress-image.sh IMAGE` runs the built image with dropped capabilities,
read-only root and the component sysctls, proves DNS/TLS readiness and EROFS, then
requires a clean stop. It also proves that a plain internal agents bridge can
reach its own on-link host gateway and is refused by the boundary check, while an
isolated agents bridge passes. The canary has live controls before and after
each probe on a separate internal bridge, at the same port. It creates disposable containers,
networks and a temporary public
policy file. This catches packaged binaries that cannot execute under the runtime
capability restrictions.

Team-image CI builds the proxy from the same reviewed checkout as the wrapper
and probes. It runs the legacy smoke and packaged ingress proof, then
`python3 test/agent-egress-boundary-image.py PROXY_IMAGE AGENT_IMAGE ROLES`
for `full` (no declaration), `aweb,registry`, `aweb,registry,secrets` and
`aweb,logs,registry,secrets` with `humanRole: "secrets"`.
Each run uses the minimal wrapper with explicit preflight-admitted IPAM,
credential-free state/login and local image content IDs; it requires live
role HTTPS controls, backend controls, denied unlisted DNS/TLS, denied host
gateway and direct backend/upstream access, then rejects an alternate-network
mutant. Only the fixture TLS frontend mounts its disposable key. The fixture
owns and removes its resources; run Docker qualification in CI, not against an
operator's daemon. The `split` argument runs the split leg on the same runner:
the probe and the witness from the deploy copy extracted from the built egress
image, a second Compose project with Redis and PostgreSQL fixtures on its own
disjoint network, unreachable from the agent project, and `192.0.2.10` (unassigned and unrouted) as the
services-host address, in bundled and external modes. It also proves that a
services address inside a Docker subnet refuses and that the witness refuses a
published port. The shared-front :443 case is pinned by unit tests; the
two-host rehearsal is the consumer's evidence for the topology.
`test/agent-egress-roles.test.mjs` pins all 31 nonempty subsets,
legacy output bytes, refusal cases and fail-closed network observations.

`python3 test/agent-egress-ingress-image.py IMAGE` exercises the packaged ingress
CLI against disposable real HTTP/1.1 and HTTP/2 TLS routes with separate backend
logs. It requires a signer-only call to fail, a complete five-route call to pass,
and a forwarded human authority returning backend 421 to fail. It retains
health-only Secrets and registry-to-Secrets misdelivery mutants, common-path
witness refusal and the valid human CSS control. It creates only
its own containers, internal network and temporary public trust fixture, and
removes its private test key at cleanup. Python 3, OpenSSL and Docker are required;
this is a transport regression, not an identity or mail-wake fixture.

`python3 test/agent-egress-humanrole-ingress-image.py IMAGE` adds a four-role
Secrets-anchor fixture with real HTTP backends behind the H1/H2 TLS ingress.
The console and Secrets API share one backend and one log. It requires the
anchor-labelled CLI PASS, and refuses human-authority forwarding into the API,
role-to-role misdelivery, and a backend returning 421 after logging the forbidden
tag. The same fixture runs without Docker in `test/agent-egress-humanrole.test.mjs`.

`test/agent-egress.test.mjs` checks policy compilation and admitted Compose
metadata. `assertComposeBoundary()` takes Docker container/network inspections,
approved agent mounts and the protected source-path inventory. Paths in that
inventory must be canonicalized by the wrapper on the engine host. Passing
metadata checks does not prove firewall, host-gateway, ingress or CNI isolation.
The shared runtime journey must attempt allowed and denied connections and reads
before launching agents, and fail on an alternate bridge, backend or key/socket
access. A false or missing enforcement result must not become PASS.

## Boundary probe on an existing Compose deployment

Run `node container/agent/egress/probe-compose-boundary.mjs --plan <runtime.json>`
on the Linux Docker engine host. The deployment wrapper stages a credential-free probe
using the agent service's image, UID/GID, security settings and static address,
with entrypoint `sleep infinity`. Its state and login mounts are empty; no seat,
controller, team key or setup-token is present. It may have a read-only public CA
mount. Remove it before starting the real service at that address.

The runtime JSON is derived by the deployment wrapper. Its fields are:

| Field | Runtime value |
| --- | --- |
| `schema` | Required integer: `1` on one engine (local mode), `2` for [split agent/services hosts](#split-agentservices-hosts). Missing or unknown schemas refuse before engine access with `E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found none; regenerate the plan with schema: 1 or schema: 2` (an unknown numeric schema replaces `none` with its value; other types report `invalid <type>`). A probe older than schema 2 refuses a schema-2 plan with its own schema-1 text. |
| `probeContainer`, `proxyContainer` | Existing running container name or ID. The deployment wrapper owns the probe's creation/removal. |
| `agentsNetwork`, `servicesNetwork` | Existing bundle network names. No replacement agents network is created. |
| `probeImage`, `proxyImage` | Reviewed repository digest references; a local content ID is also accepted for a disposable image test. |
| `uid`, `gid` | Configured numeric non-root agent IDs. |
| `approvedProbeMounts` | Expected `{Type,Source,Destination,RW}` entries from reviewed configuration, including the staged public CA and optional `/mirrors` mounts; not copied from inspect. Bind sources must resolve on this engine host. |
| `protectedSources` | Canonical private service/database directories or key paths, plus the engine socket. |
| `policy` | The same derived policy object mounted in the live proxy. |
| `allowedPaths` | Exactly the declared roles (all five without a declaration), with an existing harmless HTTP 200 control path per API; for example `/ready`, signer `/readyz`, registry `/health`. |
| `deniedBackends` | Schema 1 only. Two `{role,address,port,controlNetwork?}` records, roles `postgres` and `redis`; each address is in `policy.deniedAddresses`. `controlNetwork` selects an existing backend network for its live control, otherwise `servicesNetwork`. |
| `remoteBackends` | Schema 2 only, in place of `deniedBackends`: `{servicesAddress, backends}`. `backends` is `{role:"redis",port}` and either `{role:"postgres",port}` or `{role:"postgres",port,address,external:true}`. See [Split agent/services hosts](#split-agentservices-hosts). |
| `run` | Schema 2 only: `{id, policyHash, servicesDeployment}`, supplied by the wrapper. `id` and `servicesDeployment` are 1–128 characters of `A-Za-z0-9._:-`; `policyHash` must equal `policyHash(policy)` or the probe refuses with `E_EGRESS_POLICY_HASH`. |
| `caFile` | Optional public CA path inside the probe. The supported agent trust fragment uses `/etc/agent-trust/ca.pem` and exactly its two fixed trust settings. An explicit CA at another public probe path remains probe-only evidence. No private key in the file. |
| `namePrefix` | Optional caller-owned prefix for every temporary canary and TCP control. Use 2–64 Docker-safe characters, starting with an alphanumeric and ending in `-`; for example `lab-probe-`. |
| `protectedPaths` | Optional additional service-private paths that must not exist inside the probe. Standard secret/socket/custody paths are always checked. |

The operator-side adapter checks actual image IDs, inert entrypoint, non-root
identity, dropped capabilities, read-only root, no new privileges, exact mount
sources, the sole isolated agents network and the proxy's two networks. It
permits the agent's two fixed CA environment settings only with the configured
trust path. Public CA and mirrors are read-only and cannot overlap writable
state/work sources. Their runtime checks reuse the agent acceptance functions.
For `probe-runtime.mjs --emit-program`, set runtime `mirrors: true` only when the
platform adapter has admitted that exact read-only mount; the Compose adapter
derives it from the approved inventory.
The adapter
requires the live proxy policy to equal the derived policy and establishes live
TCP controls from the existing services/backend networks. Its own temporary host
canary binds an ephemeral port on the services bridge's gateway, then attempts
the same port on the agents network's on-link IPAM gateway. Only an unavailable
host address (`EADDRNOTAVAIL`, as expected in isolated mode) permits the second
bind to fail. Readiness follows that bind result; the in-container probe targets
the agents gateway while services controls remain live. Neither listener binds
a wildcard address. Configure an explicit IPv4 `gateway` in the agents network's
`ipam.config`: Docker can otherwise omit the gateway in isolated mode, and the
adapter refuses to infer a probe address from a subnet.

The shared in-container body requires the configured resolver and every declared
HTTPS control through that resolver and proxy. It uses the compiler's canonical
role order regardless of declaration order, including in the emitted program;
the compiler and runtime share the same `policyRoles` helper.
Registry adds the exact provisioned
namespace TXT checks, whether or not signer is declared; missing or incorrect
answers refuse admission. Signer adds negative human DNS and refusal of human TLS SNI. Every declaration
requires a fresh unlisted DNS name and TLS host to be refused, and denied direct upstream,
PostgreSQL, Redis and host-canary connections. Secret and engine-socket paths
must be absent. It reads no service credential. Only after final live controls
and zero forbidden canary hits does the adapter print exactly
`OATS_EGRESS_BOUNDARY_PASS` and exit 0. Docker and response values are withheld
on failure. On success stderr lists `egress boundary universal:` controls
separately from `egress boundary declared:` controls. Retain both streams.
Universal controls always include sole isolated network membership, an explicit
IPv4 IPAM gateway, live host-gateway refusal, direct upstream/backend refusal,
unlisted DNS/TLS refusal and absence of protected paths. An alternate bridge or
host must never be admitted to make a subset pass. The end-to-end TLS proxy does
not claim to filter encrypted HTTP paths; anchor ingress admission separately
checks the witnessed authority/path combinations above.
The adapter names each temporary container with a UUID. Without `namePrefix`,
the defaults are `oats-egress-canary-` and `oats-egress-tcp-`. A fresh ownership
label identifies each attempt. Cleanup inspects the exact name and removes it
only if that label matches; a reported name collision refuses without removing
the existing container. An anchored exact-name `docker ps -a` check must verify
absence. A Docker timeout or signal triggers an exact-name ownership inspection,
owned cleanup and another absence check; it still refuses the unproven run.
A failed observation refuses, with the exact leftover or unverified name.

Every attempt has a receipt `{name,image,network,created,absentVerified}`.
`created` means creation was confirmed by a successful run or matching ownership
inspection, never assumed after a timeout; `absentVerified` means the exact-name
absence check succeeded at the time it ran. After a timed-out run the daemon can
still complete the create later, so a container with that name can appear after a
receipt reports `created:false, absentVerified:true`; that run has already
refused, and a caller-chosen `namePrefix` finds it. Both success and refusal write `egress boundary receipt:`
JSON lines to stderr. If absence could not be verified, confirmed creations use
`egress boundary leftover:` when ownership inspection has not refused them.
Collisions, replaced names and failed ownership observations use
`egress boundary unowned or unverified:`, as do attempts whose creation was never
confirmed. A receipt records historical creation, not authority to remove the
current container: establish the per-attempt ownership label before any removal. Retain these lines even when the probe refuses.

Add `--json` to the command for machine-readable stdout. Success returns
`{"passed":true,"receipts":[...]}`; refusal returns
`{"passed":false,"receipts":[...],"error":"boundary probe refused"}` and exits 1.
The error is static; stderr retains the diagnostic and receipt lines in either
mode. Without `--json`, success keeps the `OATS_EGRESS_BOUNDARY_PASS` token and
refusal leaves stdout empty. The exported `probeComposeBoundary(plan)` returns
`{passed:true,receipts}` for schema 1 and the split document in
[Split agent/services hosts](#split-agentservices-hosts) for schema 2; thrown
failures carry `.receipts`.
The helper `tcpFromNetwork` returns `{reachable,receipt}`; callers must check
`.reachable`. With `classify: true` it returns `{result,receipt}` instead, where
`result` is exactly `CONNECTED`, `DENIED` (ECONNREFUSED, EHOSTUNREACH,
ENETUNREACH, or no connection inside the program's own deadline) or
`ERROR <code>`. Any other output, a non-zero exit or an unconfirmed cleanup
throws with the receipt. `withGatewayCanary` and `checkDockerGateway` return the canary and
two TCP control receipts, and failures carry partial receipts too.
These host-side helpers ship under `/opt/oats/deploy/egress/` with their
complete local import closure; `/opt/egress` retains only the runtime files.
Extract the deploy directory before invoking the probe on the engine host.
The manifest binds every deploy file to the image
([Dockerfile](Dockerfile), [manifest builder](../deploy-manifest.mjs)).

Kubernetes uses `probe-runtime.mjs --emit-program <runtime.json>` to emit the
same in-container body for its adapter's operator connection. That adapter must
supply and verify its admitted pod, mounts, enforcing CNI and live backend/node
canary controls. Emitting the program is not a boundary PASS. The smoke test
creates disposable networks for its regression; the deployment probe uses the
bundle's actual network and does not infer enforcement from metadata.

## Split agent/services hosts

Plan schema 2 runs the same boundary on an agent-only host, whose services
(aweb, Secrets, Logs, Redis and, optionally, PostgreSQL) run on another host's
Docker engine. It runs only from a deploy copy extracted from the reviewed egress
image: the probe reads `manifest.json` beside `egress/`, checks the SHA256 of
every file it lists, and reports its `source` as `sourceCommit`. From a source
checkout, or a copy whose files no longer match, it refuses with
`E_EGRESS_SOURCE_MANIFEST` and names the extraction to run instead.

What a split pair must prove, and the scope of each claim:

1. **Agent-host isolation.** The isolated agent reaches only the proxy, and the proxy reaches only pinned :443 targets. The universal checks and the in-container runtime program prove this, unchanged.
2. **Agent-host negative.** From exactly two vantage points, the isolated agent and the proxy's outward bridge (`servicesNetwork`), the declared services-host address does not accept TCP on the declared PostgreSQL and Redis ports. The claim covers those two vantage points, that one address and those two ports. It says nothing about other networks on the agent host, privileged host processes, or other ports.
3. **Services-host witness.** The selected PostgreSQL and Redis containers are running and healthy. Docker publishes none of their ports, and neither uses host network mode. Each accepts TCP on its port from its own private network. The claim covers what Docker publishes for those containers. It does not prove the services host has no independent listener or forwarding rule. Item 2 covers that for the declared address and ports. The witness proves what Docker publishes; a peer that has a route to the services host's bridge subnets can reach unpublished container ports on engines that allow direct routing, which [Docker Engine 28.0.0](https://docs.docker.com/engine/release-notes/28/) blocks by default unless a network sets the `nat-unprotected` gateway mode or the daemon sets `allow-direct-routing`, so the wrapper should require Engine 28.0.0 or later (the witness reports `observed.engineVersion`) or a firewall rule.
4. **Ingress.** The unchanged ingress probe, run services-side.

For an external database the proof is that the isolated agent cannot open TCP to it and the proxy will not forward to it. It does not prove the database refuses other hosts; its credentials, which the agent host never holds, are the control.

The proof is bound to the policy the running proxy loaded, not only to the
mounted file. The supervisor compiles `/etc/egress/policy.json` once at
startup and, before starting any child, writes the `policyHash` of that exact
policy to `/tmp/egress/policy.hash` (mode 0400). In split mode the adapter reads
it through `docker exec` in the proxy container, after its mounted-file
comparison and before any network control; it must equal `run.policyHash`.
Missing, unreadable, malformed or different refuses with
`E_EGRESS_POLICY_STALE: the running proxy loaded a different policy than this
plan; recreate the proxy, then prove again`. A changed policy therefore needs
the proxy recreated before it is proved. Schema 1 neither reads nor requires
the record.

`remoteBackends` declares exactly one `servicesAddress`; a second address, in
any form, refuses with `E_EGRESS_REMOTE_ADDRESSES: split mode v1 takes exactly
one services-host address`. The address need not be in
`policy.deniedAddresses`, and it may equal a declared target's pinned address:
on a shared front, one public IPv4 serves aweb, Secrets and Logs over :443. The
database denial is per address and port, never IP-wide; schema 1 keeps its
IP-wide deny and `compilePolicy` is unchanged.

The services-host address, and an external PostgreSQL address, must not be
local to the agent host, or the probe refuses with `E_EGRESS_REMOTE_LOCAL`.
"Local to the agent host" means: inside any IPv4 Docker IPAM subnet on this
engine, or exactly equal to an IPv4 address on one of the host's own interfaces
(`ip -j address show`). An address merely inside an interface's prefix is not
local, so a services host in the same VPC subnet is accepted. The probe reads
these on the Linux engine host through a local Docker endpoint, as the network
preflight does.

Redis is always on the services host. PostgreSQL runs there too, or is
`external:true` at its own pinned IPv4 `address`. An external address must be
in `policy.deniedAddresses` (the proxy can never connect to it) and differ from
`servicesAddress`, or the probe refuses with `E_EGRESS_EXTERNAL_DB_DENIED`; a
declared target address refuses with `E_EGRESS_EXTERNAL_DB_TARGET`.

The probe classifies each `(address, port)` tuple from both vantage points with
the tri-state control. The outward-bridge controls run once, after the opening
:443 positive controls, from temporary canaries on `servicesNetwork`; the
isolated agent's controls run inside the probe container (`remoteEndpoints` in
the runtime program, with no `deniedAddresses` membership requirement). Only `DENIED` passes, from a
canary that exited 0 with its cleanup confirmed. The one exception: an external
PostgreSQL from the outward bridge is recorded, not required, and may also be
`CONNECTED`; `ERROR` or malformed output still refuses. The isolated agent must
get `DENIED` from an external PostgreSQL too. Split mode creates no live
positive control for the backends, which run on another engine; the :443 target
controls, the gateway canary and every other universal check are unchanged.

`--json` on success returns:

```json
{"passed":true,"mode":"split","receipts":[],
 "run":{"id":"…","policyHash":"sha256:…","servicesDeployment":"…"},
 "sourceCommit":"<40-hex source commit of the deploy copy>",
 "remote":{"servicesAddress":"…","vantage":["isolated-agent","outward-bridge"],
   "results":[{"role":"postgres","port":5432,"address":"…","vantage":"isolated-agent","result":"DENIED","required":true}]}}
```

`remote.results` always has exactly four rows, in this order: postgres from
the isolated agent, postgres from the outward bridge, redis from the isolated
agent, redis from the outward bridge. Each row is
`{role,port,address,vantage,result,required}`, where `address` is the IPv4 the
row tested: `servicesAddress`, or an external PostgreSQL's own pinned
`address`, so a wrapper binds the external-database rows to its inventory from
this document alone. Every row is `required:true` and
`DENIED`, except postgres from the outward bridge in external mode, which is
`required:false` and `DENIED` or `CONNECTED`. Schema 1's JSON has no `mode`
field and is unchanged; refusal JSON is the same in both modes. A wrapper admits
on this JSON (`passed:true`, `mode:"split"`, its own `run`), not on the stdout
PASS line, and derives `required` from its own inventory.

### Canonical policy hash

`policy.mjs` exports `policyHash(policy)`: `"sha256:" + hex(sha256(utf8(canonical(policy))))`.
`canonical` is JSON with object keys sorted by UTF-16 code unit, recursively;
arrays in their given order; no whitespace; `JSON.stringify` string and number
encoding, with non-ASCII string values emitted raw (UTF-8). It refuses inputs
that are not portable JSON values: undefined, functions, symbols, BigInts,
non-finite numbers, non-integer numbers, integers beyond ±(2^53−1), non-ASCII
object keys, strings that are not well-formed UTF-16, cycles, and objects other
than plain objects and arrays. Python's
`json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
produces the same text. Test vector (for the helper only; not a valid
`compilePolicy` input):

```json
{"schema":1,"humanOrigin":"https://approve.example.invalid","frontAddress":"172.30.0.2","privateIngressAddresses":[],"deniedAddresses":["10.20.0.11"],"targets":{"signer":{"origin":"https://prepare.example.invalid","addresses":["203.0.113.10"]},"aweb":{"origin":"https://aweb.example.invalid","addresses":["203.0.113.10"]}},"note":"é\u2028"}
```

hashes to `sha256:89ccf024cd7fc89c045b95339895dc3f044eb248cf09159cdb876d787055b5d4`.

### Services-host witness

Run `node egress/probe-services-backends.mjs --plan <witness.json> [--json]`
from the extracted deploy copy on the services host's Linux Docker engine. Like
split mode, it refuses with `E_EGRESS_SOURCE_MANIFEST` outside an extracted copy.
The plan:

```json
{"schema":1,
 "run":{"id":"…","policyHash":"sha256:…","servicesDeployment":"…"},
 "servicesAddress":"…","composeProject":"…","policy":{},
 "backends":[{"role":"postgres","service":"…","port":5432},{"role":"redis","service":"…","port":6379}],
 "canaryImage":"…@sha256:…","namePrefix":"…-"}
```

`schema` is `1`; any other value refuses with `E_EGRESS_PLAN_SCHEMA: this
witness reads plan schema 1; found <x>; regenerate the plan with schema: 1`.
`policy` is the same derived policy the agent-side plan carries; the witness
recomputes `policyHash(policy)`, refuses a mismatch with `E_EGRESS_POLICY_HASH`
and does not otherwise use it. `backends` is exactly `[postgres, redis]` with
PostgreSQL on the services host, or exactly `[redis]` with an external
PostgreSQL. `composeProject` follows Compose's project-name rule.
`canaryImage` is the reviewed egress image pinned by digest, the same image as
the agent host's `proxyImage`; `namePrefix` is optional, as in the boundary plan.

The witness selects containers itself and does not trust a caller's container
name: for each role exactly one running container labelled
`com.docker.compose.project=<composeProject>` and
`com.docker.compose.service=<service>`; none or several refuses, naming the
project, service and the count found (`… is required for redis; found 0`). For
each it requires running and healthy, a network mode other than `host` or
`container:`, no `HostConfig.PortBindings` and no host binding in
`NetworkSettings.Ports`, the declared port in `Config.ExposedPorts` (as
`<port>/tcp`, or a bare `<port>`, which Docker reads as TCP and Compose writes
for `expose`), and a
classify-mode control returning `CONNECTED` from a canary on every network the
container joins, aimed at its address there, with cleanup confirmed. It reads
containers through an inspect template that selects only those fields: no
environment, command, mount or healthcheck log is read or printed. It reports
whether `servicesAddress` is among the services host's IPv4 interface addresses
(`addressOnHost`), an observation and not a refusal, because a NAT'd public
address is legitimately absent, and the engine's version as `engineVersion`
(`docker version --format {{.Server.Version}}`). A running container with no
healthcheck refuses with `<role> has no healthcheck; add one to its Compose
service`; one that is not running, or whose healthcheck is not healthy, refuses
with `<role> must be running and healthy`.

`--json` on success returns:

```json
{"passed":true,"run":{},"sourceCommit":"…","servicesAddress":"…","canaryImage":"…",
 "observed":{"composeProject":"…","hostAddresses":["…"],"addressOnHost":false,"engineVersion":"28.0.4"},
 "backends":[{"role":"postgres","service":"…","containerId":"…","image":"…","imageId":"sha256:…",
   "networks":["…"],"port":5432,"health":"healthy","published":false,"control":"CONNECTED"}],
 "receipts":[]}
```

Refusal returns `{"passed":false,"receipts":[...],"error":"services witness refused"}`
and exits 1. Without `--json`, success prints `OATS_SERVICES_WITNESS_PASS`.
stderr carries `services witness receipt:` lines and the refusal diagnostic.

### Pairing

The wrapper supplies one run ID and the policy hash to the boundary probe, the
witness and the ingress probe. It admits only when the boundary is
`mode:"split"` and `passed:true`, the witness passed, ingress printed PASS, all
three carry the same `run.id`, `run.policyHash` and source commit, the
boundary's and witness's `servicesDeployment`, `servicesAddress` and role/port
inventory match, the witness's observed Compose project, services and address
match the wrapper's own inventory for the selected services operator
(`run.servicesDeployment` is correlation only, never proof of identity), and
the four-row result set has `DENIED` on every row the wrapper's own inventory
marks required. In external mode the wrapper checks the external address against
the database endpoint the services operator configured. Each receipt comes fresh
over its operator's established route; there is no new signature format.
