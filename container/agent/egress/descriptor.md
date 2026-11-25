| Schema key | Existing env name or mount | Type/constraint | Default | Purpose |
| --- | --- | --- | --- | --- |
| `egress.image` | `EGRESS_IMAGE`; service image | `repository@sha256:<64 lowercase hex>` | none | One proxy image in Compose and Helm. |
| `agents.resolverIp` | `EGRESS_ADDRESS`; derived policy `frontAddress` | static IPv4 address on the agents network, or proxy Service address in Kubernetes | none | Authoritative DNS replies and TLS entry point. |
| derived role inventory | policy `roles` | optional nonempty distinct subset of `aweb`, `logs`, `registry`, `secrets`, `signer`; `targets` has exactly those keys | all five, preserving output/order | No missing/extra targets or stand-ins. Origin mappings below apply only to declared roles. |
| `aweb.publicOrigin` | derived policy `targets.aweb.origin` | exact HTTPS DNS origin on 443 | none | Agent access to aweb. |
| `secrets.publicOrigin` | derived policy `targets.secrets.origin` | exact HTTPS DNS origin on 443 | none | Agent access to the Secrets broker API, without mounting its keys. |
| `logs.publicOrigin` | derived policy `targets.logs.origin` | exact HTTPS DNS origin on 443 | none | Agent access to Logs. |
| `signer.requestOrigin` | derived policy `targets.signer.origin` | exact HTTPS DNS origin on 443; equals validated profile `request_origin` | none | Signed prepare and receipt access, conditional on runtime Host/SNI refusal proof. |
| derived human anchor | policy `humanRole` | optional `"signer"` or `"secrets"`; signer must be declared for `"signer"`; `"secrets"` requires declared `roles` including secrets and excluding signer, plus `humanOrigin` | signer when absent | One ingress anchor; no inference or third role. A bundle setting the field needs the new image; existing deployments change nothing. |
| signer human origin or wrapper-derived Secrets console origin | derived policy `humanOrigin` | exact HTTPS DNS origin; required with signer or `humanRole: "secrets"`, otherwise refused; neither routed nor external | none | Prevent the human console becoming an agent destination; Secrets console/API may share backend and log. |
| `team.registryUrl` | derived policy `targets.registry.origin` | exact HTTPS DNS origin on 443; equals validated profile `registry_origin` | none | Sender verification in the broker's Node channel-core child and Go aw. |
| `team.registryRoute` | runtime audit `registry` entry: `{path,log}` or `{path,external:true}` | wrapper-owned `local` or `external`; only registry may be external | external in the deployment bundle | Local ownership requires its backend witness; external uses matched verified-TLS 200 only, with no remote refusal/non-delivery claim. Existing local-registry bundles must select `local`. |
| derived namespace authority inventory | wrapper supplies `authorityRecords` from provisioned public authorities | required with registry, refused without registry; existing AWID parser and registry-origin/profile binding against `team.registryUrl` | none | Exact `_awid` TXT records for registry discovery and sender verification, independently of signer; no invented signer dependency or second namespace/controller input. |
| `signer.profileFile` | existing signer profile validation | validated existing ProtectedServiceProfile, only with signer | none | Where it supplies authority material, retain its `namespace_authorities` and `registry_origin` checks; registry authority records remain required without signer. |
| `egress.privateIngressAddresses` | derived policy `privateIngressAddresses` | explicit approved IPv4 ingress addresses; no CIDR or wildcard | empty | Permit private TLS ingress only where declared. Reserved/metadata/loopback and protected-backend denials still take precedence. |
| derived upstream inventory | policy `targets.<role>.addresses` | 1–8 pinned IPv4 addresses per role, resolved/checked before launch | none | No runtime DNS rebinding or general outbound proxy. |
| `egress.external.source` | derived `externalTargets.source.origin` | boolean selects only `https://github.com` | false | Direct Git HTTPS source reads; no repository/path/method restriction. |
| `egress.external.model` | derived `externalTargets.model.origin` | boolean selects only `https://api.anthropic.com` | false | End-to-end model TLS; no knowledge/publication role. |
| `egress.external.resolvers` | derived `externalResolverAddresses` | 1–4 distinct public IPv4 literals, operator order, DNS port 53; required only with an enabled external role | none | Egress-only resolution; every answer is checked before connecting by IP. Agent DNS remains authoritative. |
| derived protected inventory | policy `deniedAddresses` | exact protected backend IPv4 addresses, including PostgreSQL and Redis | none | Protected destinations override private ingress exceptions. |
| derived policy artifact | `EGRESS_POLICY_FILE`; `/etc/egress/policy.json`, read-only | complete non-secret artifact specified in README; at most 64 KiB | none | Same generated policy interface for both wrappers, not another operator file/schema. |

| Secret file under `/run/secrets/egress/` | Owner/mode | Who provisions it |
| --- | --- | --- |
| none | No secret mount or serving TLS key. | TLS terminates at the operator ingress. Profile authorities and CA certificates are public trust material. |

| Key | Platform | Why no shared form |
| --- | --- | --- |
| `agents.network.subnet`, `agents.network.address` | Compose | Docker bridge CIDR/static endpoint; Kubernetes uses its pod network and proxy Service. The minimal wrapper admits `AGENTS_SUBNET`, `AGENTS_GATEWAY`, `AGENT_IP`, `EGRESS_ADDRESS`, `SERVICES_SUBNET`, `SERVICES_GATEWAY` with the read-only engine-host preflight. Failed observations or overlap across every Docker IPAM entry, IPv4 route table and link address refuse. Only proxy joins agents and services; agents network is internal with Docker >=28 isolated gateway mode, not a host-addressed bridge. |
| `egress.kubernetes` selectors/Service address | Kubernetes | NetworkPolicy selects agent/proxy pods and pinned ingress addresses; requires measured CNI enforcement. Compose uses explicit bridge membership. |
| policy artifact bind source | Compose | Wrapper-generated host path, canonicalized on the Docker engine host. Kubernetes mounts the same bytes from a ConfigMap. |

Image: `container/agent/egress/Dockerfile`, one built digest; fixed uid/gid 10001:10001, no credential or operator allowlist baked in.
Port: UDP/TCP 53 and TCP 443, component DNS/service name `egress`.
Health: `node /opt/egress/health.mjs`; exact approved DNS answer, unknown-name NXDOMAIN and live TLS listener; readiness only, not boundary proof.
Depends on: validated shared deployment config, provisioned namespace authorities with registry and a signer profile only with signer; pinned ingress inventory; an enforcing network boundary and owned TLS ingress rejecting SNI/Host/:authority disagreement before routing; no PostgreSQL, Redis or custody mount.

The probe's `allowedPaths` inventory matches exactly the declared roles. Its
stderr report distinguishes universal obligations (unlisted DNS/TLS refusal,
sole isolated network, explicit IPv4 IPAM gateway, live host-gateway refusal,
backend/direct-upstream denial and protected-path absence) from declared HTTPS
controls, registry-specific exact authority TXT checks and anchor-labelled
human-host checks (signer by default, explicit Secrets otherwise). The proxy does not
filter encrypted HTTP paths. Stage public sources before credentials, without
a codeload exception. Keep compiler/proxy image, minimal wrapper and probes at
one reviewed source commit and retain built image digests. Team-image CI builds
the egress image and exercises the legacy full set, `{aweb, registry}` and
`{aweb, registry, secrets}` using the actual minimal Compose wrapper.
