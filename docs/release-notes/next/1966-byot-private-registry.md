## Changed

- **The getting-started skill sets up a workspace on the person's own aweb
  server on a private AWID registry too** (#1966). Step 1 no longer stops
  there: it asks the registry's origin, and tells the person that their
  namespace's `_awid` DNS record must name that registry
  (`aw id namespace prepare-controller --domain <domain> --registry <origin>`
  makes one that does). Before the prerequisite check and the team's
  creation, step 9 records it with `oats aweb setup --soul <soul> --registry
  <origin>`, the host setting `settings.oats.aweb.registry` that admits a
  private registry. The skill still never sets `AWID_REGISTRY_URL`. That
  branch needs oats.aweb 1.43.0 or later, the first release with
  `--registry`; the public registry keeps 1.42.1. If the computer account
  already runs a wake broker for another registry
  (`E_WAKE_REGISTRY_CONFLICT`), the skill stops and leaves the choice to the
  person.
