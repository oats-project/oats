## Upgrade

- **After upgrading, check for a schedule slot without its record.** An
  earlier OATS killed while it took a job's slot could leave the directory
  `<deployment>/.agents/schedules/locks/<id>/` with no `owner.json` in it.
  This OATS never writes into it or removes it: the tick reports `job lock
  custody is unreadable` for that deployment and runs none of its jobs, and
  the slot counts against `maxConcurrent`. Once you have checked that the job's last run is not
  running (`oats schedule show <id>`), remove the directory by hand, or
  forget the job with `oats schedule remove --force <id>`.

## Fixed

- **A schedule's job slot is never left without its record.** The slot was
  made as an empty directory and its record written into it after, and
  released by removing the record before the directory, so a tick killed
  between the two steps left a slot that held a host slot for ever and
  stopped that deployment's ticks with `job lock custody is unreadable`. The
  record is now written first, in a directory beside the slots, and that
  directory is renamed to the slot; a release renames the slot out before
  removing it ([Schedules](../schedules.md#files)).
