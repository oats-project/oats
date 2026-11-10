## Upgrade

- **After upgrading, release any schedule slot left without its record.**
  An earlier OATS killed while it took a job's slot could leave the
  directory `<deployment>/.agents/schedules/locks/<id>/` with no
  `owner.json` in it. This OATS never writes into it or removes it for
  you: `oats doctor` lists it as a `schedule-slot-unreadable` problem, the
  tick reports that job invalid, and the slot counts against
  `maxConcurrent`. Check `oats schedule show <id>`; once its last run is
  not running, run `oats schedule reconcile <id> --clear` to release it
  ([Schedules](../schedules.md#files)).

## Added

- **`oats doctor` lists a schedule slot whose record cannot be read** as a
  `schedule-slot-unreadable` problem, `{code, severity, scope, id, message,
  remedy}`, naming the deployment, the job and the remedy
  ([Schedules](../schedules.md#what-a-run-reports)).

## Fixed

- **A schedule's job slot is never left without its record.** The slot was
  made as an empty directory and its record written into it after, and
  released by removing the record before the directory, so a tick killed
  between the two steps left a slot without its record. The record is now
  written first, in a directory beside the slots, and that directory is
  renamed to the slot; a release renames the slot out before removing it
  ([Schedules](../schedules.md#files)).
- **A slot whose record cannot be read stops only its job.** Such a slot
  (an earlier OATS's, a hand edit, a disk fault) made every tick of its
  deployment fail with `job lock custody is unreadable`, so none of the
  deployment's jobs ran, and `oats schedule reconcile` answered `nothing to
  reconcile`. The tick now reports only that job `invalid` and runs the
  others; `oats schedule reconcile <id>` answers the remedy, and
  `reconcile <id> --clear` releases the slot once you have checked, also
  when the schedule is no longer defined
  ([Schedules](../schedules.md#files)).
