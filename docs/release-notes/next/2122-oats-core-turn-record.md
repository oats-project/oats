## Added

- **A Claude Code agent's row says whether it works on a turn or waits**
  (`oats.core` 2.17.0, [#2122](https://github.com/oats-project/oats/issues/2122)).
  oats.core's Claude Code hooks record each turn's boundary in
  `<home>/.oats/turn.json`, which a kernel that lists `status-activity` reads
  as the row's [`activity`](../desktop-cli-api.md#row-activity):
  `UserPromptSubmit` writes the turn's start, a launch prompt's included;
  `Stop` and `StopFailure` its end; and Claude's `idle_prompt` notification
  ends a turn whose end no hook reported
  ([the turn record](../capabilities.md#oatscore-the-turn-record)). Nothing is
  written for Codex, whose row reads `null`. Claude Code reports no
  interrupt (Esc), so a Claude Code row reads `null` from 30 minutes into a
  turn with no end. A home takes the hooks at its next start once its
  oats.core is 2.17.0: a new spawn, or `oats instance upgrade`. The hooks
  write a file an older kernel never reads.
