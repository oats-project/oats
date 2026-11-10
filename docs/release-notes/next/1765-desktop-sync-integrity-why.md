## Fixed

- **The Desktop explains a refused sync's `E_PACKAGE_INTEGRITY` for what it
  is** (oats-project/oats#1765). The sync sheet said every such refusal meant
  a moved tag or a branch, including a lock whose capabilities or souls were
  edited and a package whose manifest names another id. It now reads the
  kernel's `why`: a branch pin says to pin a tag or a full commit; a
  manifest naming another id says to change the pin as Details says; an
  edited lock says to remove that package's entry from the lock file. A moved
  tag, or a case this Desktop doesn't know, gets the general meaning: the
  package doesn't match what the workspace file or the lock records for it.
  The kernel's message stays under Details
  ([`oats sync`](../desktop-cli-api.md#oats-sync)).
