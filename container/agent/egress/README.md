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

`targets` contains exactly those five roles. Origins are exact HTTPS DNS origins
on port 443. Addresses are pinned IPv4 literals resolved and checked before the
proxy starts. Private ingress addresses need explicit exceptions; loopback,
metadata and reserved addresses remain denied. `deniedAddresses` lists protected
backend addresses, including PostgreSQL and Redis, and overrides exceptions.
These five upstreams never use live DNS. The agent-facing DNS is authoritative,
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
addresses, in operator order, with no default. DNS uses UDP/TCP port 53.
Both derived fields are absent with neither role enabled. The component checks
the exact roles, origins and resolver addresses again. No knowledge-publication
role, npm, codeload, raw-file or release-asset host is included.

Agents resolve configured external names to the proxy address. Only the
proxy resolves their upstream addresses, for each new connection. An
image-owned loopback connector validates every returned IPv4 address, rejects
mixed safe/unsafe answers, and connects to the selected IP literal without a
second lookup. Private, loopback, link-local, reserved and denied addresses,
the proxy, private-ingress exceptions and every pinned deployment target are
excluded. External routes never inherit internal private-ingress exceptions.
DNS and connect work has a five-second bound; there is no default upstream,
recursive agent DNS, CONNECT endpoint or automatic host expansion.

The external guarantee is exact declared SNI plus a validated public
destination. TLS stays end to end. It does not filter encrypted HTTP
Host/`:authority`, paths, methods or repositories. Source access can read any
public repository on the allowed host; request paths and queries can disclose
data. Absence of a provisioned Git credential is not a network prohibition on
introducing one. Any authorized push credential must be scoped to one repository.
Provider requests can contain prompts, decrypted messages, files and tool output.

With external roles configured, CoreDNS logs denied questions and nginx logs
refused SNI names. The connector reports refusal by role without request bodies,
credentials or resolved values. A real harness start and turn must retain all
refused names; another required host is a finding, not permission to add it.

The runtime body checks each enabled external name resolves only to the proxy
and receives an ordinary 2xx–4xx HTTP response over verified TLS, without following
redirects. These are connectivity controls, not readiness or public-backend
non-delivery evidence. Owned DNS/TLS mutants and shipped-client checks qualify
external enforcement separately from the five-service common-audit proof below.
Generic read-only mirror support remains available; it is not needed by the
direct source role.

After building the proxy, explicit public-host QA runs as:

```sh
sh test/agent-external-egress-image.sh <proxy-image-id> <existing-agent-image-id>
```

This fixture creates its own internal isolated agents network and services
bridge, uses the agent image's shipped Node and Git without starting its broker,
and checks public HTTPS, Git `ls-remote`, undeclared DNS/SNI refusal and refusal
logs. It selects `1.1.1.1` and `8.8.8.8` only for that disposable fixture. It
contains no login, seat or model request and removes its own resources. Set
`EGRESS_EXTERNAL_EVIDENCE` to retain the proxy log. Run the original
`test/agent-egress-image.sh` separately for the five-service baseline and the
plain-versus-isolated gateway regression. Neither fixture proves a model turn,
verified wake, the actual deployment boundary or Kubernetes enforcement.

The wrapper derives `authorityRecords` only from the signer's validated
`namespace_authorities` and `registry_origin`, using the existing AWID TXT
encoding and parser. It checks the profile against `team.registryUrl` and the
configured signer origins. Enabling agents requires that signer profile. Each
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

Kubernetes uses the same image and derived policy. An enforcing CNI must restrict
agent egress to proxy TCP/UDP 53 and TCP 443, and proxy egress to the pinned TLS
ingress addresses on TCP 443. An installed NetworkPolicy object alone does not
prove enforcement. The agent must have no service credentials or backend access.
External roles also need proxy-only access to the selected DNS resolvers and
validated public TLS destinations; their Kubernetes adapter/CNI qualification
is separate from the Compose component proof.

**An SNI map does not enforce HTTP origins.** Before enabling the signer route,
the TLS ingress must reject mismatched SNI and HTTP Host, including HTTP/2
`:authority`, before routing. The runtime journey must show that allowed request
SNI with the excluded human Host/authority cannot reach the human service, that
matched traffic succeeds, and that unknown or absent SNI has no default route.
If this cannot be proved, keep the signer route closed and use isolated ingress
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

`--audit-path` declares one common path whose request tags every backend can
witness, such as `/ready` with health-only service logging. Before and after the
negatives, separate matched-SNI/Host coverage controls call this path on every
role/address and the human surface over HTTP/1.1 and HTTP/2. Coverage controls
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
query tags must appear for matched controls in the appropriate backend log, and
all forbidden tags must be absent from every supplied log. Final matched controls
and common-path coverage on each route/address and the human surface provide
later log records after the negative cases. Responses and log contents
are never printed. Success prints exactly `OATS_EGRESS_INGRESS_PASS`; require
that token and exit 0 before enabling the signer route and admitting agents.

The CLI requires `--policy <derived-policy.json>` and
`--route-logs <runtime-audit.json>` and `--audit-path <common-path>` together;
a partial signer-only call or missing audit path fails
without an admission token. The latter file has exactly the policy's five role
keys, each holding `{ "path": "/ready", "log": "/logs/aweb.log" }` for that
role's harmless 200 endpoint and actual backend log. Use signer `/readyz` and
registry `/health` where those are the supported routes; `--human-path` and
`--human-log` still name the human surface. Begin capturing every backend before
the call. The policy supplies all origins and pinned addresses; it is not copied
into a new operator schema. `--address` must be one pinned signer address for
the final human control. If supplied, the compatible `--request-log` and
`--request-path` must equal the signer's runtime-audit entry.

Full mode tests each routed SNI at each pinned address, over both protocols,
with matched controls and human-authority, wrong-port and suffix refusals.
Unknown/absent SNI is tested per distinct address. Matched tags must reach their
own backend log, including a final matched control after the negatives; no
forbidden tag may reach any supplied backend. The wrappers require this complete
proof before admission. The evidence covers the tested authority/path
combinations, not arbitrary path-dependent forwarding or rewrites. `--ca-file`
adds its public certificates to Node's normal public roots.

## Build and prove

Build from this directory with `docker build -t <local-name> .`. The image runs as
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

`python3 test/agent-egress-ingress-image.py IMAGE` exercises the packaged ingress
CLI against disposable real HTTP/1.1 and HTTP/2 TLS routes with separate backend
logs. It requires a signer-only call to fail, a complete five-route call to pass,
and a forwarded human authority returning backend 421 to fail. It retains
health-only Secrets and registry-to-Secrets misdelivery mutants, common-path
witness refusal and the valid human CSS control. It creates only
its own containers, internal network and temporary public trust fixture, and
removes its private test key at cleanup. Python 3, OpenSSL and Docker are required;
this is a transport regression, not an identity or mail-wake fixture.

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
| `probeContainer`, `proxyContainer` | Existing running container name or ID. The deployment wrapper owns the probe's creation/removal. |
| `agentsNetwork`, `servicesNetwork` | Existing bundle network names. No replacement agents network is created. |
| `probeImage`, `proxyImage` | Reviewed repository digest references; a local content ID is also accepted for a disposable image test. |
| `uid`, `gid` | Configured numeric non-root agent IDs. |
| `approvedProbeMounts` | Expected `{Type,Source,Destination,RW}` entries from reviewed configuration, including the staged public CA and optional `/mirrors` mounts; not copied from inspect. Bind sources must resolve on this engine host. |
| `protectedSources` | Canonical private service/database directories or key paths, plus the engine socket. |
| `policy` | The same derived policy object mounted in the live proxy. |
| `allowedPaths` | Exactly the five roles, with an existing harmless HTTP 200 control path per API; for example `/ready`, signer `/readyz`, registry `/health`. |
| `deniedBackends` | Two `{role,address,port,controlNetwork?}` records, roles `postgres` and `redis`; each address is in `policy.deniedAddresses`. `controlNetwork` selects an existing backend network for its live control, otherwise `servicesNetwork`. |
| `caFile` | Optional public CA path inside the probe. The supported agent trust fragment uses `/etc/agent-trust/ca.pem` and exactly its two fixed trust settings. An explicit CA at another public probe path remains probe-only evidence. No private key in the file. |
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

The shared in-container body requires the configured resolver, all five allowed
HTTPS controls through that resolver and proxy, the exact namespace TXT records,
negative unknown/human DNS, refusal of human TLS SNI, and denied direct upstream,
PostgreSQL, Redis and host-canary connections. Secret and engine-socket paths
must be absent. It reads no service credential. Only after final live controls
and zero forbidden canary hits does the adapter print exactly
`OATS_EGRESS_BOUNDARY_PASS` and exit 0. Docker and response values are withheld
on failure. It removes only its own canary/control containers.

Kubernetes uses `probe-runtime.mjs --emit-program <runtime.json>` to emit the
same in-container body for its adapter's operator connection. That adapter must
supply and verify its admitted pod, mounts, enforcing CNI and live backend/node
canary controls. Emitting the program is not a boundary PASS. The smoke test
creates disposable networks for its regression; the deployment probe uses the
bundle's actual network and does not infer enforcement from metadata.
