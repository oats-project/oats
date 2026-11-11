## Changed

- **`oats session resume` tries a refused start again, and counts a home's
  starts per hour.** A start the sweep ran and that was refused (a launch
  variable not set, no wake broker running yet) launched nothing and says how
  the host was at that moment. It no longer answers the loss for good: the
  sweep tries that home again no sooner than 1 minute later, doubling to 15
  minutes at most, until the loss is 24 hours old. A home that keeps getting
  lost is still started at most 3 times, now in an hour instead of in a boot,
  and a sweep starts it again when the oldest of those starts is an hour old.
  Both the count and the delays are kept for one boot.

  **Contract change for clients of `oats session resume --json`**
  ([the machine sweep](../desktop-cli-api.md#the-machine-sweep-oats-session-resume)):
  - the row reason `refused-this-boot` is no longer emitted. A refusal that
    is waiting for its next attempt is `start-refused-retrying`, with the
    refusal's `code` and `message`;
  - `start-refused`, `start-refused-retrying` and `keeps-getting-lost` rows
    carry `nextAttemptAt`, an ISO time (not on a host without a boot id,
    where nothing is noted);
  - `keeps-getting-lost` keeps its name and now means 3 starts in the last
    hour, not in this boot, and it is no longer final;
  - a refused start and `keeps-getting-lost` no longer make later sweeps
    answer the home `not-seen-recently`.
