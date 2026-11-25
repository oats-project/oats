## Added

- **A running agent's row says whether it works on a turn or waits at its
  prompt** (feature `status-activity`,
  [#2122](https://github.com/oats-project/oats/issues/2122)). `oats status
  --json` instance rows and `oats server roster --json` rows gain `activity`:
  `"working"`, `"idle"` or `null` where OATS cannot tell
  ([`activity`](../desktop-cli-api.md#row-activity)). The key is only on a
  row whose session is there, and no act reads it. A tmux row that runs reads
  the last turn boundary its harness wrote into `<home>/.oats/turn.json`,
  counted only from the row's `startedAt`: `@awebai/oats-pi` writes it for pi
  from this release, and oats.core's hooks for Claude Code from the oats.core
  release that follows; until an instance has both this kernel and such a
  writer its row reads `null`, and a Codex row always does. A Claude Code row
  whose turn started more than 30 minutes ago with no end reads `null`,
  because Claude Code reports no interrupt. A provider row carries its
  provider's own answer, the new optional `activity` key of `inspect` and
  `inspectMany` ([capabilities.md](../capabilities.md#inspect-and-inspectmany));
  a provider that sends none reads `null`. An older client ignores the field.
