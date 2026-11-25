## Fixed

- **The mail sheet shows the rest of the mail when one team's identity
  can't be read** (#2138). A messaging provider that can't read who an
  agent is in one team answers that team's `identities[]` entry with an
  empty `alias` and `identity` beside its `error` (oats.aweb 1.48.0 and
  later do, for example with `identity-missing`). The Desktop refused the
  whole answer as one it couldn't read; it now says "Mail from `<team>`
  can't be read" and shows the rest of the mail. The `messaging:mail`
  contract states the rule for every provider: `alias` and `identity` may be
  `""` only where `error` is non-null, with `error: null` an empty one is
  still refused, and `team` is never empty. `mailApi` stays 1. A Desktop
  before this release still refuses the whole answer in this case:
  upgrading it mends that
  ([Mail, `mailApi: 1`](../desktop-cli-api.md#mail-mailapi-1)).
