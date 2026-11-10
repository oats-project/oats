## Upgrade

- **After upgrading, remove a start lock directory an earlier OATS left.**
  An earlier OATS made the directory `<home>/.oats-start.lock` for each
  session start and could leave it behind when the start was killed. This
  OATS makes nothing there: `oats session start` and `restart` refuse a
  home with that directory with the new code `E_SESSION_START_LOCK_STUCK`,
  naming it, and never remove it; `oats instance upgrade` refuses it too,
  naming it. Remove the directory once no earlier `oats` is running on the
  machine. The resume sweep reports such a home as a refused start
  (`start-refused`, with the code) instead of skipping it as one where a
  start is running. The Desktop and `oats tui` show it as a start that
  started nothing, with a sentence that says to remove the lock its message
  names once no earlier OATS is running, since waiting will not clear it.

## Changed

- **A session start makes no `.oats-start.lock` directory.** Two starts of
  one home already excluded each other through the home's lifecycle claim
  (#1602); the start lock directory was a second guard that a killed start
  left behind, after which every start of the home answered
  `E_SESSION_START_BUSY` until it was removed by hand. A start now only
  reads that path: a package upgrade that has not finished is refused as
  before, naming its same-key retry
  ([Desktop CLI API](../desktop-cli-api.md)).
