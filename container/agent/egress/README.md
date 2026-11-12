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
is IPv4 and internal. Only the proxy joins both `agents` and `services`; IP
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
requires a clean stop. It creates only a disposable container and temporary public
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
