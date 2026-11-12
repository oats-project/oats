# Agent egress proxy component

The team-container deployment can build a non-root DNS/TLS egress image and
extend its Compose service. It routes only the named aweb, Secrets, Logs, signer
request and registry hosts, using pinned upstream addresses and profile-derived
public namespace TXT records. There is no recursive DNS or mounted service key.

The agent Compose fragment requires `AGENT_TMP_SIZE`, in positive integer bytes
from the shared `agents.tmpSize` input, and applies it to the `/tmp` tmpfs. Its
acceptance check refuses a missing or different limit.

Optional fragments add a public CA file with two fixed trust settings, or
operator-maintained bare Git mirrors at read-only `/mirrors`. Acceptance checks
their exact mounts and refuses writable-state aliases, multiply linked CA files
and arbitrary environment changes. The fixed public trust reaches the supervisor,
broker, direct SSH commands and login-captured tmux panes while retaining normal
public roots. No service credential or TLS verification bypass is added.

Runtime acceptance proves the agent's own on-link gateway denial with live
controls and a plain-versus-isolated bridge regression. The ingress probe checks
every policy route over HTTP/1.1 and HTTP/2, with required full-policy inputs,
initial/final backend controls and non-delivery for forbidden human authorities;
known-name refusals require completed TLS. Partial signer-only CLI calls cannot
emit the admission token.
Both checks must pass before agents launch. Readiness and rendered policy alone do not establish
isolation. See the [component contract](../../container/agent/egress/README.md).
