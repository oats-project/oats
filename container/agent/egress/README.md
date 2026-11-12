# Agent egress component

This image runs authoritative CoreDNS and an NGINX stream TLS forwarder. Agents
resolve approved service names to the proxy and reach only its DNS and TLS ports.
TLS stays end to end. The shared deployment wrapper owns operator configuration,
network creation, the ingress and the policy file; this component defines no
second operator schema.

## Derived policy

The wrapper mounts a non-secret JSON file read-only at `/etc/egress/policy.json`.
Its complete field set is:

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
There is no live upstream DNS or general recursive resolver.

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

**An SNI map does not enforce HTTP origins.** Before enabling the signer route,
the TLS ingress must reject mismatched SNI and HTTP Host, including HTTP/2
`:authority`, before routing. The runtime journey must show that allowed request
SNI with the excluded human Host/authority cannot reach the human service, that
matched traffic succeeds, and that unknown or absent SNI has no default route.
If this cannot be proved, keep the signer route closed and use isolated ingress
listeners or upstreams. Exact authority and port comparisons are required.

## Ingress admission probe

Both wrappers run the same probe from services-side connectivity before admitting
agents. Capture the actual request and human backend access logs first; the logs
must include request query strings. Do not use the TLS frontend access log as
proof that a backend received nothing.

```sh
node /opt/egress/probe-ingress.mjs \
  --address <ingress-ipv4> \
  --request-origin https://prepare.example.invalid \
  --human-origin https://approve.example.invalid \
  --request-log <request-backend-log> \
  --human-log <human-backend-log> \
  --ca-file <public-ca.pem> \
  --request-path /readyz \
  --human-path /handoff-assets/handoff.css
```

The files are operator-side probe inputs; never mount backend logs into an agent.
Both log paths may name one file when the surfaces share a backend process.
Choose an existing, harmless endpoint returning 200 on each matched surface,
using `--request-path` and `--human-path` when their routes differ. Forbidden
human-authority cases use the human path. The compatible `--path` option sets
both defaults (otherwise `/ready`). Certificate chain and service-name checks
stay on.
Without `--ca-file`, Node's normal trust configuration applies.

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
all forbidden tags must be absent from both logs. Final human controls establish
that logging still works after the negative cases. Responses and log contents
are never printed. Success prints exactly `OATS_EGRESS_INGRESS_PASS`; require
that token and exit 0 before enabling the signer route and admitting agents.

The deployment qualification must add `--policy <derived-policy.json>` and
`--route-logs <runtime-audit.json>`. The latter has exactly the policy's five role
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
own backend log; no forbidden tag may reach any supplied backend. The old
signer-only call is a compatibility check, not the five-route deployment proof.
The wrappers must call full mode before admission. `--ca-file` adds its public
certificates to Node's normal public roots.

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
