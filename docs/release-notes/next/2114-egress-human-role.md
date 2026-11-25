## Added

- Egress policies may set `humanRole: "secrets"` to prove human-console refusal
  without signer. Declared roles must include secrets and exclude signer, and
  `humanOrigin` is required. Secrets API and console may share a backend and log;
  ingress admission still requires refusal before any forbidden backend delivery.
  The ingress and boundary reports name the anchor.

## Upgrade

- Existing deployments change nothing: an absent `humanRole` retains the signer
  rule and generated proxy/DNS bytes. A bundle setting `humanRole` needs the new
  egress image; older images refuse the field.
