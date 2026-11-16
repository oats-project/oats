# The checkpoint: a wake that bounds a wait

## Contents
- Set one
- When you can't set one
- A wait handed to you
- When it fires
- A second overdue checkpoint ends the wait

## Set one
From your home, one per instance you wait on, each time you hand it something:

```bash
oats session inspect --home "$OATS_INSTANCE_HOME" --json   # read wakeHold first (below)
node -e 'const d=new Date(Date.now()+<minutes>*60000);console.log(d.getUTCMinutes(),d.getUTCHours(),d.getUTCDay())'
cat > checkpoint-<slug>.json <<EOF
{"kind":"wake","enabled":true,"cron":"<minute> <hour> * * <weekday>","tz":"UTC","home":"$OATS_INSTANCE_HOME",
 "message":"Checkpoint: <instance> owes <result>. If it came, remove this job and stop; if not, follow 'When it fires' in the checkpoint reference of /wait-and-retire."}
EOF
oats schedule add "$OATS_INSTANCE-<slug>" --file checkpoint-<slug>.json
oats schedule show "$OATS_INSTANCE-<slug>" --json   # nextRun must be the moment you meant
```

- **`<minutes>`** is the time until the result is overdue (the table in the skill): about
  60 for a review round, about 240 for a child's piece, about 1440 for a lead's next
  result.
- **`<weekday>`** is `*` for a wait of less than a day. For a day or more, a lead's next
  result included, it is the weekday the command prints.
- **The cron repeats on purpose.** A minute the host slept through is never replayed, so
  a pinned date would stay silent for a year; this one comes round again.
- **When the result arrives,** remove the job: `oats schedule remove
  "$OATS_INSTANCE-<slug>"`. If that refuses because the job is running, the wake started
  your stopped session: add `--force`, which stops nothing.
- **A later checkpoint:** remove the job and run the recipe again (`add` refuses an id
  that exists). A second one's message starts "Second checkpoint:", so the wake says
  which one it is, even after a restart.

## When you can't set one
- **`wakeHold`.** A wake's Enter answers whatever your session is showing, so set a wake
  only where `wakeHold` reads `on-claims` or `not-exposed`. With `unknown`, or no
  `wakeHold`, set none.
- **The host timer.** No wake fires unless `oats schedule add` succeeds and `oats
  schedule host status` answers `active: true`, `registered: true` and no `problems`.
  Installing the timer is the operator's.
- **`E_SCHEDULER_BUSY`** may be a tick holding the lock: run the command once more a
  little later. That lock is never yours to remove.

In each case hand the wait up, once, in one line (who owes what, by when):
- a developer to its expert, and a lead or a specialist to its parent, which sets the
  checkpoint on its own home (next section);
- with no parent, say in the effort's status line that nothing bounds this wait;
- a maintainer tells its person (through its parent, if it has one), and notes it in its
  state file.

## A wait handed to you
A child that can't set a wake hands you its wait on its own child (a developer's
reviewer, a lead's developer). Set a checkpoint on **your child**, on your home, naming
in its message the instance it waits on and what that owes. It watches your child, never
that instance: inspecting and replacing it is your child's.

When it fires and your child still waits, your child's own checkpoint is due. Tell it in
one line ("your checkpoint on <instance> is due: follow 'When it fires' in
the checkpoint reference of /wait-and-retire"), and set the next one half as far out, its message starting "Second
checkpoint:". When that one fires, your line says "second checkpoint", and your child
ends its wait as below. The child takes your first line as its first checkpoint and your
second as its second. A child that neither moves nor answers your line is stalled
itself: "When it fires" applies to it.

## When it fires
The result is overdue, nothing more: a reason to look, not proof the instance failed, and
no reason to interrupt one that is working. Read its row in `oats status --json`,
`oats instance events <instance> --json` (`waitingClaims`), and its work (`oats instance
git <instance>`, its PRs, its record). Then:

- **A result or a question reached you and you missed it:** act on it.
- **A claim says what it needs:** give it, or pass it to whoever it is for.
- **A `wake-held` event** is history, not a state. Read the job it names (`oats schedule
  show <schedule> --json`): only a `lastRun` that still carries `held` means its wake is
  waiting, and then someone outside it has to act. Tell your parent (with none, your
  person). Never clear the claim or answer the dialog yourself: a claim can be stale,
  but a live dialog takes the next Enter.

The next two are for any instance but a reviewer, whose wait always ends at its second
checkpoint:
- **The result moved** (new commits on its branch, a new PR, a new review, comment or CI
  run on its PR, a new status line on its record, or its reply naming what it waits on):
  set a later first checkpoint. A start, a claim or a lifecycle event is not movement.
- **It waits on someone else** (a reviewer, a person, another lane) and says so: it is not
  stalled, and no wait on an answer ends by time. Set a later first checkpoint, never a
  second one on that account. A wait it handed you is the exception (above).

What is left depends on what you wait on.

**A reviewer** is replaced, never restarted:
- its claim says its turn failed, or `running` is false with `sessionEnd` `exited` or
  `lost`: replace it now;
- `running` is false with `sessionEnd` `stopped`, or none: it may have been stopped on
  purpose. Replace nothing, and ask your expert whether it should run;
- anything else: ask it one precise question through your messaging layer, and set a
  second checkpoint, half as far out.

**Any other instance:**
- `running` is false, `sessionEnd` `exited`: it ended by itself. Start it again with
  `oats session start --home <home>`, and set a second checkpoint;
- `running` is false, `sessionEnd` `lost`: add `--resume` to that start, and set a second
  checkpoint;
- `running` is false, `sessionEnd` `stopped`, or none: it may have been stopped on
  purpose. Don't start it: ask your parent (with none, your person) whether it should run;
- its claim says its turn failed, or nothing shows: `running` with no claim says nothing
  either way. Ask it one precise question through your messaging layer, which also gives
  a failed turn a new start, and set a second checkpoint, half as far out.

## A second overdue checkpoint ends the wait
The instance neither moved nor answered. Never set a third: on a reviewer at all, or on
another instance whose result hasn't moved. Never read silence as approval.
- **A reviewer:** spawn a new one with the same brief, retire the stalled one (`oats
  retire <name>`), and say so in your hand-back.
- **Any other instance:** check `oats retire <instance> --plan` and retire it. A work
  tree holding work is kept, but its own children are only stopped and move to you, and
  their wakes would start them again: retire each of those too, the same way. Then hand
  the spec and what the branches hold to a new instance, and tell your parent.

Don't stop an instance instead of retiring it: a stopped home's pending wake starts it
again.
