## Fixed

- **A home whose package is gone is pointed at a respawn, for every package**
  (oats-project/oats#1759, items 2 and 3). A workspace that stops declaring a
  package leaves the homes composed from it on their recorded copies, and only
  a respawn moves them.
  - `oats readiness --home` no longer tells such a home to declare the package
    again: the `package <package>/<soul>` item's remedy is to spawn a new
    instance from a soul the workspace offers, then retire this one. Readiness
    of a soul (`--soul`) still names declaring the package and `oats sync`
    ([`oats readiness`](../desktop-cli-api.md#oats-readiness)).
  - `oats session start` and `restart` add one warning for package modules an
    upgrade cannot move, because their package is no longer locked or no
    longer provides the capability, naming each and the respawn. Before, only
    modules behind the lock got a hint. `drift` is unchanged: it lists the
    modules an upgrade moves in place
    ([Start and restart](../desktop-cli-api.md#start-and-restart)).
