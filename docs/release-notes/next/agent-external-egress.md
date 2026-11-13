## Added

- The egress component can enable two fixed external roles: Git HTTPS at
  `github.com` and model HTTPS at `api.anthropic.com`. Operator-selected public
  IPv4 DNS resolvers are required, with no default. Agent DNS still points only
  at the proxy. Each external connection rejects unsafe or deployment addresses
  and connects to a validated IP without resolving it again.
- External enforcement is exact SNI plus a public destination; it does not filter
  HTTP authorities, paths, methods or repositories, or prove non-delivery at a
  public backend. The five pinned internal routes and their backend audit remain
  separate. Runtime checks add verified-TLS external controls and refused-name
  logging. Claude launch settings suppress ancillary traffic, whose actual host
  requirements still need a real authorized start and turn.
