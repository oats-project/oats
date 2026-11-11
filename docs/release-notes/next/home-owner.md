## Changed

- **A lifecycle command is refused on a home its user does not own.**
  `oats session start` (and a resume), `oats instance stop`, `oats retire`
  and `oats instance upgrade` run what a home contains: its hooks, its
  harness, the Git of its repositories. Run as another user they would lend
  that user's authority to whoever can write the home. Each now answers
  `E_HOME_NOT_OWNED` before it writes anything when the user it runs as does
  not own the home, with the two uids in `details` and the command to run
  instead. Root is refused like any other user. This is rule 3 of the
  [trust model](../trust-model.md#the-line), held by the kernel. A deployment
  that ran `oats` as root against agents' homes must run it as the agents'
  user.
