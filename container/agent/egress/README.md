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
count as rejections; a timeout or certificate-validation error fails. A peer
`internal_error` alert is accepted only before TLS completes and before any HTTP
response, and only for the enumerated unknown/absent-SNI cases. The same alert
fails for known SNI or a matched control. Unique
query tags must appear for matched controls in the appropriate backend log, and
all forbidden tags must be absent from both logs. Final human controls establish
that logging still works after the negative cases. Responses and log contents
are never printed. Success prints exactly `OATS_EGRESS_INGRESS_PASS`; require
that token and exit 0 before enabling the signer route and admitting agents.

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
requires a clean stop. It also establishes a host-gateway canary as a positive
control on an ordinary internal bridge, then requires connection denial from an
isolated bridge while that canary stays live. It creates disposable containers,
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
