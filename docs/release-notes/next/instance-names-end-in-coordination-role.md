## Changed

- **oats.core names an instance for its role in your coordination, not for
  its soul.** `oats-souls` "Name the instance" now says: `--name
  <descriptive>-<role>`, where the role is the new instance's role in your
  coordination as your landing rules and coordination skills name it
  (`lead`, `developer`, `reviewer`), or one word for what it does when there
  is no coordination; at most five words; nothing appended, since the soul is
  shown beside the name. It no longer tells agents to end a name in the last
  word of the soul's name (`desktop-improvements-developer` for a lead's
  developer, not `desktop-improvements-expert` for any expert soul). A task
  written for a spawn states the new instance's role in its first lines,
  because a suggested name reads it from there. `oats-operate` "Naming" points
  at that rule. `--purpose` (`<soul>-<purpose>`) and the numbered fallback are
  unchanged: schedules and triggers still name their runs that way. An
  instance spawned with an older oats.core keeps the old rule until it is
  respawned or its package modules are upgraded (`oats instance upgrade`).
