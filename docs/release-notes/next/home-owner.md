## Changed

- **A lifecycle command is refused on a home its user does not own.**
  `oats session start` (and a resume), `oats instance stop`, `oats retire`
  and `oats instance upgrade` run what a home contains: its hooks, its
  harness, the Git of its repositories. Run as another user they would lend
  that user's authority to whoever can write the home. Each now answers
  `E_HOME_NOT_OWNED` before it writes anything when the user it runs as does
  not own the home, with the two uids in `details` and the command to run
  instead. Root is refused like any other user. This is rule 3 of the
  [trust model](../trust-model.md#the-line), held by the kernel.

## Upgrade

- **A deployment that runs `oats` as root, or as an operator account,
  against homes another user owns** must run those commands as the homes'
  owner, with that user's `HOME`: `sudo -H -u '#<uid>' oats session start …`,
  and the same for `oats instance stop`, `oats retire` and
  `oats instance upgrade`. Without `-H` the command may keep the caller's
  `HOME` and use the wrong `~/.oats`. A deployment where one user runs both
  `oats` and the agents, the team container among them, changes nothing.
