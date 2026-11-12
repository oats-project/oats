# Agent and egress Helm library

`oats-team-agent` is a **library** dependency, version `0.1.0`. The installable
chart belongs at aweb `deploy/team/chart`. This component supplies resources
through one named renderer, called with the **root context**:

```yaml
# Root Chart.yaml (source example; pin the reviewed source/artifact in the wrapper)
dependencies:
  - name: oats-team-agent
    version: 0.1.0
    repository: file:///path/to/reviewed/oats/container/agent/chart
```

```gotemplate
{{/* Root templates/agents.yaml; invoke only when agents are configured. */}}
{{ include "oats.agent.resources" . }}
```

Do not pass `.Values.agents` as the context. The renderer reads literal root
`.Values.agents` and `.Values.egress`, plus `.Release` and root `.Files`. It does
not read dependency-scoped values, an alias or `global`. It has no `values.yaml`
and no `values.schema.json`. The wrapper validates the single canonical aweb
`deploy/team/config.schema.json` and supplies normalized inputs through its
shared `render_env.py normalize(config)` path. This library supplies no defaults. The wrapper preserves absent platform
subsections; a Kubernetes caller must explicitly supply `agents.kubernetes`,
including its required public-key source. Once present, its child defaults come
from that one shared normalizer.
The integration reference is aweb commit
`0bd24fb05b5096b2ebfe1b9a44f662bd3f997f77`, including `descriptors/agents.md`,
`descriptors/egress.md` and `egress_policy.py` in `deploy/team/`.

## Consumed canonical fields

| Root input | Rendered meaning |
| --- | --- |
| `agents.image`, `egress.image` | Complete image references pinned by SHA-256 digest. |
| `agents.uid`, `agents.gid`, `agents.kubernetes.fsGroup` | Positive non-root integer IDs, at most 2147483647. |
| `agents.caFile` | Optional public PEM source; the wrapper stages root `generated/agent-ca.pem` for the fixed trust projection below. |
| `agents.secrets` | Existing harness-login Secret, read-only at `/etc/agent-login`, mode 0440. |
| `agents.cpus`, `agents.memory` | Agent CPU and memory limits. Memory is an integer byte count. |
| `agents.tmpSize` | Integer bytes for the memory-backed `/tmp` emptyDir. |
| `agents.resolverIp` | Sole agent IPv4 nameserver and `egress` Service ClusterIP. It must be available in the cluster's Service CIDR. |
| `agents.kubernetes.stateSize`, `.storageClass` | Integer-byte RWO claim size; empty class omits `storageClassName`. Storage must honour fsGroup. |
| `agents.kubernetes.requests.cpu`, `.requests.memory` | CPU and integer-byte memory requests. |
| `agents.kubernetes.ephemeralStorage.request`, `.limit` | Integer-byte ephemeral-storage accounting. |
| `agents.kubernetes.authorizedKeys.kind`, `.name` | Existing ConfigMap or Secret with `authorized_keys`, mounted read-only with mode 0444. |
| `agents.kubernetes.imagePullSecrets` | List of existing Secret names, converted to Kubernetes `{name: ...}` entries for both images. |
| `agents.kubernetes.imagePullPolicy` | Kubernetes image pull policy for both images. |
| `agents.kubernetes.mirrorsClaim` | Optional existing operator-provisioned mirror PVC, read-only at `/mirrors`; never the generated state claim. |
| `agents.kubernetes.service.enabled` | Optional agent ClusterIP Service on TCP 2222. |
| `egress.privateIngressAddresses` | Cross-check of the derived artifact's explicit private ingress exceptions. |

`agents.network` and `agents.compose` belong to the shared deployment configuration;
this Kubernetes renderer does not create a Compose network or read Compose paths.
CPU values are numeric, in whole millicores. Byte quantities are emitted as exact
decimal strings, never suffixed strings or scientific notation; values beyond the
safe integer range are refused. Requests must be positive and not exceed limits.
The existing admission ceilings remain CPU request 0.5 / limit 2 and memory request
2147483648 / limit 4294967296 bytes. `/tmp` memory counts against the agent memory
limit; it supplies no additional memory allowance.

## Generated policy artifact

The wrapper stages the exact public JSON returned by the existing
`deploy/team/egress_policy.py derive(config, profile, addresses, denied)` in the
**root chart** at `generated/egress-policy.json`. The renderer reads it with root
`.Files.Get "generated/egress-policy.json"`. Do not place it under `templates/`,
exclude it with `.helmignore`, or supply it as a values key. It contains public
deployment data, never credentials or operator-authored policy YAML. No source or
service key is mounted in either workload.

The renderer fails with a fixed diagnostic if the artifact is absent, over 64 KiB,
invalid JSON, has the wrong field/role set, or grants unsafe destinations. It
checks the resolver address and private exceptions against canonical inputs.
The ConfigMap contains the artifact unchanged; the proxy image compiles that same
policy as in Compose. Its public authority records already passed the wrapper's
existing AWID parser and signer-profile binding. This chart does not invent an
identity authority or a second operator policy.

The `egress` Service exposes UDP/TCP 53 and TCP 443. The mandatory agent
NetworkPolicy permits only those ports to this release's egress pods in the same
namespace. The proxy policy permits ingress only from agent pods on those ports,
and egress only to the artifact's pinned target IPv4 addresses as `/32` peers on
TCP 443. It permits no recursive DNS, other private exceptions, or backend access.
The authoritative resolver and TLS forwarder use the same digest image as Compose.

The proxy runs as 10001:10001, with RuntimeDefault seccomp, no token or service
links, no capabilities or privilege escalation, read-only root, a read-only policy
ConfigMap and a 16777216-byte memory-backed `/tmp`. Its fixed limits are 1 CPU and
268435456 bytes; it uses a 5-second stop grace. Its pod requires
`net.ipv4.ip_forward=0` and `net.ipv4.ip_unprivileged_port_start=0`. The cluster must
admit these namespaced sysctls without removing them or adding capabilities. The
Compose PID cap has no pod-spec equivalent; cluster PID limits belong to kubelet
configuration. `node /opt/egress/health.mjs` supplies proxy readiness.

A NetworkPolicy object is **not proof of CNI enforcement**. The wrapper must prove
live allowed/denied paths, node/backend bypass resistance and exact SNI/Host and
HTTP/2 authority enforcement before admitting agents. A cluster unable to enforce
the policy or admit the security settings must fail admission, not weaken them.
The fixed `egress` Service name assumes one team deployment per namespace.

## Optional public CA

When `agents.caFile` is configured, the root wrapper reads that public source
and stages its bytes at `generated/agent-ca.pem`. This library never reads the
operator's absolute path or turns it into a hostPath/Secret. It emits a dedicated
agent CA ConfigMap, mode 0444, projected read-only at
`/etc/agent-trust/ca.pem`. Only `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` are set,
both to that exact path. Kubernetes supplies these settings before the image's
entrypoint and supervisor start; no TLS verification bypass or arbitrary env
injection is accepted. The image must support this approved trust contract.

The artifact must contain only public `CERTIFICATE` PEM blocks, at most 64 KiB (65536 bytes).
Helm checks its envelope and bound; host acceptance parses every block as X.509
and requires `X509Certificate.ca === true` for each one. It rejects valid leaf
certificates, private-key material and other data. This matches the Compose CA
contract. The wrapper must validate the
public certificates before deployment. Missing configured artifacts fail with
a fixed diagnostic that withholds the source content. Without `agents.caFile`,
no CA ConfigMap, extra mount or trust setting is added, even if an unused artifact
is present in the root. A public checksum in the pod template triggers replacement
on certificate changes; the subPath projection itself is not refreshed in place.

Agent acceptance checks the rendered bundle, admitted ConfigMap, exact read-only
projection and the two declared trust settings. These are metadata/content checks;
real certificate-chain verification and supervisor inheritance still need native
image/deployment evidence. The chart creates no CA key or certificate authority.

## Optional operator-maintained mirrors

`agents.kubernetes.mirrorsClaim` selects an **existing** operator-provisioned PVC
of bare Git mirrors. It works without `agents.mirrorsDir`; Kubernetes never reads
that Compose host path. If `agents.mirrorsDir` is configured without an explicit
claim, rendering refuses it and names `agents.kubernetes.mirrorsClaim`.

The claim is mounted at `/mirrors`, outside writable `/state`, with both the PVC
volume source and the mount read-only. The chart refuses its own generated writable
state claim (`state-<agent-StatefulSet-name>-0`) as a mirror source. Acceptance
also refuses another writable mount, a changed admitted claim, hostPath sources,
or alternate paths. The one agent state claim template remains unchanged; no
mirror PVC/store, fetch process, credentials, init container or extra environment
setting is created. Read-only mounts cannot detect an unknown storage-level alias;
the operator must provision a genuinely separate, credential-free mirror source.

The operator owns source URLs, approved refs and the source/ref/refresh manifest,
and refreshes the mirrors outside the agent. No repository credentials belong in
this PVC. The existing team-state Git configuration can rewrite canonical URLs
to `file:///mirrors/`; it remains operator-maintained. PVC presence is **not** proof
of mirror freshness, source integrity or successful cloning. Native mount and
Git-consumer evidence remains a separate deployment check.

## Agent lifecycle and acceptance

The agent retains one replica, one RWO PVC, `OnRootMismatch` fsGroup handling,
RuntimeDefault seccomp, dropped capabilities, read-only root, no privilege
escalation/token/service links, the approved login/public-key mounts, a size-limited
memory-backed `/tmp`, 45-second stop grace and `maxUnavailable: 1` PDB. Release
names must be DNS-1035 labels no longer than 36 characters. Optional SSH Service
exposure is ClusterIP only; the operator still uses pod port-forward and SSH.

Liveness executes `node /usr/local/lib/agent-liveness.mjs`; readiness checks TCP
2222. There is no SSH startup probe: later SSH loss must not restart the team.
The separately built agent image must contain the approved liveness helper; this
chart does not change image pins or publish an image.

```sh
helm lint /path/to/aweb/deploy/team/chart --strict --values normalized-deployment.yaml
helm template team /path/to/aweb/deploy/team/chart --namespace team --values normalized-deployment.yaml
container/agent/accept-kube.sh --chart /path/to/aweb/deploy/team/chart --values normalized-deployment.yaml --namespace team --release team
```

Acceptance selects only the actual agent StatefulSet, account, PDB, optional SSH
Service and mandatory agent policy from the full root render. It does not select
aweb, signer or proxy objects merely because they share a Kubernetes kind. This
script's render PASS is agent admission evidence; proxy metadata is separately
covered by the render gate, and its live boundary needs the wrapper's own proof.

The existing explicit `--context --pod --ssh-key` live route, optional
`--delete-pod`, fixed diagnostic labels, exact probe token, persisted known_hosts
and ordered-shutdown/replacement checks remain. Without `--chart`, acceptance
explains that a library requires an installable root path. The cluster-free gate
is `node --test test/agent-chart.integration.mjs` with `HELM` set if necessary.
Its temporary root fixture depends on the real library and is test infrastructure,
not another production chart. Tested Helm version: **3.19.2** (CI checksum-pinned).

## Unshipped standalone disposition and provenance

The former standalone chart in held PR **#1883 has not shipped**. Its flat values,
optional forwarder controls and standalone install route are replaced by this
library and the canonical deployment root. Existing approvals do not carry.
**#1883 remains native FAIL and held**; a render PASS does not lift it.

The dependency identity remains `oats-team-agent` version `0.1.0`, from the reviewed
OATS source tree at `container/agent/chart`; it has no published artifact or
published digest. The held source baseline was
`a6ed872d54c0d8d2e9572e30711ccb5ca738ca3b`. Integration must record the final reviewed
source commit, chart name/version, the root dependency source and lock, and the
SHA-256 of the exact `helm package` archive it consumes. A locally generated
archive hash is provenance for those bytes only, never a registry publication or
an image digest. Repackaging can change archive bytes; verify the actual archive.

Later native proof requires the released agent image containing the helper and
host/supervisor fixes, real enforcing CNI checks, and fsGroup-honouring storage.
The persisted SSH host key must retain 0600 and match through replacement, with
strict SSH and an observed ordered stop. A bare local-path volume claim cannot
prove kubelet/CSI fsGroup remount behaviour. CI, native authentication/seats,
verified mail/chat and runtime network evidence remain separate gates.
