## Changed

- **oats.framework 1.31.0** (`oats.core` 2.17.0, `oats.knowledge-theory`
  1.1.6).
  - `oats.core`'s Claude Code hooks record each turn's start and end in
    `<home>/.oats/turn.json` (#2122 KP-5; the entry "A Claude Code agent's
    row says whether it works on a turn or waits"). `/oats-operate` names the
    row's new `activity` field and the turn record's Node range (#2027).
  - `oats.knowledge-theory`'s capability-authoring reference shows the
    current `oats.framework` pin in its example.
  - A home takes the new hooks and skills at a new spawn or through
    `oats instance upgrade`, once `oats sync` has taken the new tag.
