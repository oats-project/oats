## Added

- **The egress proxy routes external origins a deployment names.** Each
  key of the policy's `externalTargets` is a role name
  (`^[a-z][a-z0-9-]{0,31}$`, at most 16 roles). `source`, `model` and
  `forge` (`https://api.github.com`) have fixed origins; any other role is
  an exact `https://<lowercase DNS name>`, for example a mail group's
  `ms-graph: https://graph.microsoft.com`. Each role gets the source/model
  mechanism: an exact-SNI route, its own connector, resolution through
  `externalResolverAddresses` and refusal of private or mixed answers; TLS
  stays end to end. A policy whose services are all hosted elsewhere
  declares `"roles": []` and only external roles, with `authorityRecords`
  allowed without the registry role. Policies that name only source and
  model compile and hash exactly as they did; each new refusal has a
  stable message
  ([egress README](../../container/agent/egress/README.md#deployment-named-external-roles)).
  Team-image CI checks the routes against real public origins with a
  verified TLS handshake on pull requests that change the egress component.
