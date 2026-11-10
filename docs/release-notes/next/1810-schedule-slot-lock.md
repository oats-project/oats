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
- **`oats doctor` lists a schedule slot whose schedule is gone** as a
  `schedule-slot-orphaned` problem of the same shape, naming the run and the
  instance its record names, and, for a workspace schedule, the time of the
  saved snapshot that says it is gone. A workspace schedule absent from the
  snapshot that cannot be shown gone is listed with the step that applies.

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
  `reconcile <id> --clear` releases the slot once you have checked
  ([Schedules](../schedules.md#files)).
- **A slot left by a schedule that is gone can be released.** A local
  schedule removed by hand, or a workspace schedule removed upstream, could
  leave its slot, which every tick counted against `maxConcurrent` and no
  command could release: `oats schedule reconcile` and `remove --force`
  answered `E_SCHEDULE_UNKNOWN`. The slot still counts until it is released,
  since its run may still be going; `oats schedule reconcile <id>` now
  answers what it found, and `reconcile <id> --clear` releases it once you
  have checked, with the job's retained attempt and state. A workspace
  schedule is gone only when the saved snapshot shows it: run `oats
  automations refresh` first if the snapshot is stale. One that is disabled,
  untrusted or placed elsewhere is refused as before
  ([Schedules](../schedules.md#files)).
