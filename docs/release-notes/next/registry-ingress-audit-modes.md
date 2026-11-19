## Upgrade

- Deployment bundles default `team.registryRoute` to `external`. Existing
  deployments with a registry Compose service must set `team.registryRoute: local`
  before upgrading; external mode refuses a local registry service or an owned
  destination. Local mode must refuse a URL the local service does not serve.

## Changed

- The shared ingress probe accepts an explicitly external registry with a harmless
  verified-TLS 200 control at every pinned address over HTTP/1.1 and HTTP/2. It
  reports positive connectivity only, without third-party refusal or backend-log
  claims. The other four service routes and signer/human authority refusal keep
  their full owned-backend audit. External registry addresses must not overlap
  deployment destinations; no new route or forwarding policy is added.
