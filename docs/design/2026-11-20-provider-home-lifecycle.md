# The launch state machine of a provider home

Status: design of record for the lifecycle of a home on a session provider
([execution-targets.md](../execution-targets.md#session-providers),
[capabilities.md](../capabilities.md#session-providers-sessionproviders)).
Decided 2026-11-20. The tests in `test/session-provider-lifecycle.test.mjs`
follow the tables below: one test per cell of "The verbs, by state", one per
crossing, and one per point between two writes at which the kernel can die
(it is killed there, by a seam, and the records it leaves are checked).
`test/session-provider-explorer.test.mjs` goes over what the tables do not
list one by one: for each verb, the kernel ends at each seam it passes (each
point between two writes, and each provider call: before, during, after),
then another verb runs, then an input, against a provider that has sessions;
and the invariants below are checked once everything has settled. In the
suite it runs a seeded sample, in seconds; `npm run test:provider-lifecycle`
runs every schedule (minutes). Pull-request CI runs every schedule, as a job
of its own that the gate requires, for a change that touches the lifecycle
(the files `scripts/provider-lifecycle-changed.mjs` lists: this page, the
code and the tests named here, the workflow), and a nightly run does on
main.

**The invariants.** (1) No session runs that no record names. (2) A home
recorded planned has no session; one recorded stopped has none but the one
its record names, and not that one either once a stop of it was confirmed.
(3) No home is left that no verb can act on: every verb answers a kernel
code, and a retire takes the home. (4) No input is delivered after a stop
was confirmed. (5) A home whose start, restart or resume was answered, or
whose input was submitted, has the session its record names running: nothing
a kernel left behind stops it afterwards.

A provider runs the session; **OATS decides what state the home is in, from
its own records alone**. The provider is asked only what a record cannot say
(is the session there, is it running) and is told what to do. This page says
which records exist, which states they spell, what each verb does in each
state, in what order it writes, and what happens when two things cross.

## The records

| Record | Where | Who can write it | What it holds |
|---|---|---|---|
| **Receipt** | `<instances>/.oats-retirement/baselines/<hash of the home>.json`, `runtime` | the kernel; outside the home | the authority: `launched`, `backend`, `provider`, `endpoint`, `stoppedAt`, `launchSent` |
| **Composition** | the same receipt, `composition` | the kernel (a spawn, and an upgrade's swap); outside the home | what the home may run: the digest of every module copy as the spawn made it, and its capability rows (settings, hook commands). No verb of this page writes it; every one reads it, before it runs anything of the home ([What the kernel trusts in a provider home](../capabilities.md#what-the-kernel-trusts-in-a-provider-home)) |
| **Record** | `<home>/instance.json` | the kernel; inside the home, so the agent can | a copy for readers: `launched`, `backend`, `session {provider, endpoint}`, `startId` |
| **Stop receipt** | `<home>/.oats-stop.json` | the kernel; inside the home | which stop the last one was, for the current `startId`: an operator's, or the host's (`resume: true, reason: "host-stop"`) |
| **Claim** | `<instances>/.oats-retirement/claims/<name>.lock` | the kernel; outside the home | which lifecycle verb acts on the home now, and its process |
| **Resume count** | `OATS_HOME_DIR/session-resume/provider-resumes/<hash>.json` | the kernel; outside the home | the resumes of the last hour, this boot |
| **Provider call in flight** | `<instances>/.oats-retirement/provider-calls/<name>/<verb>-<pid>-<id>.json`, and `….json.group` | the kernel (the `.group` file: the leader of the process group the provider's command runs in); outside the home | a launch, an input or a stop is being sent for the home now: by which kernel process, and in which process group the provider's command runs |

The receipt decides. The record must agree with it
(`E_RUNTIME_AUTHORITY_MISMATCH` otherwise), **except while the receipt says a
launch is unsettled** (`launchSent`): then the record's `launched`,
`session.endpoint` and `startId` are not compared, because the launch that
would have written them may have ended at any point.

## The states

A state is what the receipt says. `E` is an endpoint, `t` an instant.

| State | Receipt `runtime` | Record | Meaning |
|---|---|---|---|
| **planned** | `{launched: false, backend, provider}` | `launched: false`, `session.endpoint: null` | never launched; no session exists |
| **sent** | `{launched: true, backend, provider, launchSent: t}` (no endpoint) | `launched: true` (not compared) | a first launch was sent; its outcome is not recorded |
| **running** | `{launched: true, …, endpoint: E, stoppedAt: null}` | `launched: true`, `session.endpoint: E`, `startId` | OATS started a session at `E` and has not stopped it |
| **stopped** | `{…, endpoint: E, stoppedAt: t}` | as running | OATS stopped it. The stop receipt says which stop: **operator** (stays down) or **host** (a resume brings it back) |
| **resent** | `{…, endpoint: E, stoppedAt: t or null, launchSent: t2}` | (not compared) | a launch was sent for a home launched before; its outcome is not recorded |

Two things are not states of the records:

- **lost**: the records say *running* and the provider says the session is
  gone. Only an inspect tells; nothing is written. A lost session is resumed
  through `input`, under the home's cap.
- **retiring**: any state, with the claim held by a retire. It ends with the
  home removed.

*sent* and *resent* are the **unsettled** states: a session may run that no
record names. A launch in progress and a launch whose command died look the
same to a read; the claim tells them apart for a verb (a live holder is busy;
a dead one is taken over).

**The older kernel.** A kernel from before session providers refuses every
verb on a home whose receipt says `launched: true` without a tmux endpoint,
a retire included, and would retire a `launched: false` home as never
launched. That is why *sent* says `launched: true` in the receipt and in the
record, though no session is known to exist.

## Settling

An unsettled home is settled by one procedure, used by every verb that acts
on it (stop, start, restart, retire), under that verb's claim:

1. Ask the provider: `stop {home, endpoint: null, launchSent: t}`: stop
   whatever session rooted at this home was created at or after `t`.
2. Not confirmed: `E_SESSION_STOP_FAILED`; the state is unchanged, and the
   next verb asks again. (A retire goes on all the same when no process works
   in the home, with a warning that names the provider's own tooling: it
   never strands a home on a provider that does not answer.)
3. Confirmed: no session of that launch runs. The record is rewritten to
   agree with what the receipt will say, then the receipt:
   - from *sent* → **planned** (record `launched: false`, `endpoint: null`);
   - from *resent* → **stopped** (record `launched: true`, `endpoint: E`;
     receipt `stoppedAt` set if it was null, `launchSent` removed; the stop
     receipt as an operator's, unless it already says the host's).

*resent* settles to *stopped*, never to *running*. Step 1 does not reach the
session at `E`: it is older than the launch (a start of a lost home stops it
only after its mark, and may have died before). So **every verb that settles
a resent home asks `stop {endpoint: E}` first**, and settles only once that
is confirmed: then neither the old session nor the new launch's runs. Not
confirmed, the home is not settled, whichever verb asked (a retire, which
removes the home, asks for both stops all the same and records nothing).

## A launch (spawn's, start's, restart's)

Always the same steps, under the home's claim (`start`; a spawn takes it
before its home can be acted on):

| # | Step | Record written | State after |
|---|---|---|---|
| 1 | What can refuse, in this order: a module copy of the home that is not the one its receipt records (every copy is hashed, since the plan reads all their manifests); the provider's `check` with the planned launch (the harness, yolo, the sandbox allowances, the home's trees and the launch configuration's own arguments), **before any hook runs**; then the plan and the launch hooks. A spawn or a start its backend refuses runs no hook. (Three checks run right before step 4: the home's roots, the kernel's shim, the host run's admission. One that refuses there leaves the home as it then is: stopped by step 3, or as before the verb) | none | unchanged |
| 2 | If unsettled: for a home launched before, the provider's `stop {endpoint: E}` (not confirmed: `E_SESSION_STOP_FAILED`); then settle | see Settling | planned or stopped |
| 3 | If launched before: stop the session at `E`. A restart of *running* whose session is there records `stoppedAt` and the stop receipt first (the stop rule). A start or a restart of *stopped* asks the provider's `stop {endpoint: E}` again; not confirmed is `E_SESSION_STOP_FAILED`, nothing started. (*Running* whose session is gone: step 4) | receipt, stop receipt (a restart of a session that is there) | stopped, or running-and-gone |
| 4 | **Mark**: receipt `launchSent: t` (and `launched: true` from planned), then the record's `launched: true` from planned. Then, for *running* whose session is gone, the provider's `stop {endpoint: E}`, and nothing is recorded of it (so a stop that is not confirmed leaves a lost home lost, not stopped as by an operator): not confirmed is `E_SESSION_STOP_FAILED`, the mark taken back (6b), nothing started. After the mark, because an input holds no claim: see the crossings | receipt, then record | sent or resent |
| 5 | The provider's `launch` | none | sent or resent |
| 6a | It answered `E'`: receipt `endpoint: E'`, `stoppedAt: null`, **`launchSent` kept**; then the record (`launched: true`, `endpoint: E'`, new `startId`); then the receipt's `launchSent` removed (a spawn removes it at its end, after its lineage is committed, so that no input is admitted to a home whose spawn may still be undone; and only then does a keyed spawn's record say it completed, so a same-key retry never replays an unsettled home as finished) | receipt, record, receipt | running at `E'` |
| 6b | It refused (nothing was started): **unmark**: record, then receipt | record, then receipt | as before step 4 |
| 6c | Its answer was lost: settle | see Settling | planned or stopped; or unchanged when the stop is not confirmed |

A launch killed at any point after step 4 and before the last write of 6a
leaves an unsettled home: the next verb settles it. There is no point at
which the receipt names a session the record contradicts, or at which a
session runs that the receipt does not account for with either an endpoint
or `launchSent`.

A spawn writes its home's receipt, as planned, BEFORE it publishes the
record, and again after it; so a spawn that ends between the two leaves a
planned home, never a record without a receipt, and a spawn that reuses the
name of a retired home (whose receipt a retire keeps, by its path) is never
paired with that one. A spawn that fails after step 4 undoes itself: 6b or
6c (its fence first: the launch's mark, written again if it was gone
already; then the drain, as for every stop), then the home is removed. A home it keeps for another debt after a stop that was confirmed (a
hook's cleanup is owed) is left planned, record and receipt alike, with its
rollback marker. When the stop of 6c is not confirmed the home is retained,
unsettled, with its rollback marker. A retire of a retained provider home
reads the launch from its receipt and record, never from the marker.

## The verbs, by state

`—` means the provider is not called.

| Verb (claim) | planned | sent | running | stopped | resent |
|---|---|---|---|---|---|
| **inspect**, **status** (none) | not launched; — | unknown (`E_SESSION_UNAVAILABLE`; row `unreachable`); — | the provider's `inspect`; unknown when it fails; gone reads *lost* | stopped; — | unknown; — |
| **input** (none) | `E_SESSION_NOT_RUNNING`; — | `E_SESSION_NOT_RUNNING`; — | `inspect`, then `input` (below) | `E_SESSION_NOT_RUNNING`; — | `E_SESSION_NOT_RUNNING` when `stoppedAt` is set, else `E_SESSION_INPUT_FAILED`; — |
| **stop** (`stop`) | nothing to stop | settle → planned; answers stopped | the stop rule → stopped | operator's: asks `stop {E}` again, and takes a host's stop as its own. Host's: nothing | as of *running* or of *stopped* by its `stoppedAt` (the stop rule, or `stop {E}` again), then settle → stopped; answers stopped |
| **start** (`start`) | launch | settle, launch | `inspect`: there → `E_SESSION_RUNNING` or `E_SESSION_UNKNOWN`; gone → launch | launch | `stop {E}`, settle, launch |
| **restart** (`start`) | launch | settle, launch | `inspect` (unknown refuses): there → the stop rule, launch; gone → launch | launch | `stop {E}`, settle, launch |
| **resume** (`resume`) | `E_RESUME_NOT_LOST` | `E_SESSION_UNKNOWN` | gone → count, then `input` (the notice); there → `E_SESSION_RUNNING` / `E_RESUME_NOT_LOST` | host's stop → `input` (the notice), then `stoppedAt` cleared, then the stop receipt removed → running; operator's → `E_RESUME_NOT_LOST` | `E_SESSION_UNKNOWN` |
| **retire** (`retire`) | remove | settle, scan, remove | the stop rule, scan, remove | `stop {E}` again, scan, remove | the stop rule, settle, scan, remove |

**The stop rule: fence, drain, stop.** Every stop the kernel asks of a
provider, whatever the verb, is made by one function, in this order:

1. The **fence**: the record from which no new input is admitted. For a stop
   of a *running* home (stop, restart, retire, the host's shutdown): an
   earlier stop's receipt is removed (one a resume that died left names this
   same start, and would make this stop the host's), then receipt
   `stoppedAt: t`, then the stop receipt. For a launch: its mark. A home
   that is stopped or unsettled already has its fence. A fence that cannot
   be written refuses the verb before the provider is asked, a retire too:
   without it an input is still admitted.
2. The **drain** of the provider calls recorded for the home (see "A
   provider's command outlives the kernel that ran it"): an input that is
   being sent is waited for, at most an input's timeout and a margin (about
   25 s), and ended if it outlasts that or if its kernel is gone.
3. The provider's `stop {endpoint: E}`.

A stop the provider confirms is therefore final: nothing admitted before the
fence is still on its way. Not confirmed is `E_SESSION_STOP_FAILED` (a
retire goes on when no process works in the home, with a warning), and the
home is *stopped* all the same: from the fence on, input is refused whatever
the provider does. The cost is the wait of step 2, while an input is in
flight.

**Scan** (a retire): no process may work in the home after the provider's
stop, confirmed or not.

**A resume's notice that fails.** Refused by the provider (a prompt is open,
it was queued): nothing was sent; a lost session's count is given back, and a
home stopped with the host stays so, still to resume. Failed otherwise: the
provider may have restarted the session on it; a lost session's count stays,
and for a home stopped with the host, which stays stopped, the provider is
asked `stop {E}` again.

**Input to a running home**: `inspect`; gone is a lost session, whose input
is a resume (counted before the provider is called, refused at the cap);
then the record is read again, `input` is sent, and the record is read once
more (the crossing check, below).

## Crossings

**A verb arrives while another holds the claim.** Stop, start, restart,
resume and retire take the claim; a second one is refused as busy
(`E_LIFECYCLE_BUSY`, `E_SESSION_START_BUSY`, …) before any effect. A spawn
of a provider home, launched or not, holds the claim from before its home is *planned* on disk until its last
write of the home's record (after its launch is recorded) or until its
launch is undone, so the home is never acted on while it launches, and no
verb's record is overwritten by the spawn's.
Reads (inspect, status, the plans) take no claim: they answer the state the
records spell at that instant, which during a launch is *sent* or *resent*,
that is, unknown.

**The holder died.** A claim names its holder by process id and that
process's start time. A holder is gone when no process has that id, or the
one that has it started at another time (the id was reused), or it is a
zombie; a holder whose liveness cannot be read is not gone, and the verb is
refused as busy. The next verb takes over a gone holder's claim. The records
are in one of the states above whatever the point of death, by the write
orders of "A launch" and of the stop rule:

| Died | State left | The next verb |
|---|---|---|
| before the mark (step 4) | as before the verb | acts on it |
| between the mark's two writes | sent, record `launched: false` (not compared) | settles |
| during the provider's launch, or after its answer and before the last write of 6a | sent or resent; a session may run | settles: the provider stops it by home and `launchSent` |
| during the stop rule, after `stoppedAt` | stopped (as an operator's until the stop receipt is written, then as the stop's own); the provider may not have been asked | a stop or a start asks `stop {E}` again |
| during a settle, after the provider confirmed | unsettled still, or settled | settles again (the provider's stop is idempotent), or acts |
| during a launch the provider refused, between the record and the receipt of its unmarking | sent | settles (there is nothing to stop) |
| during a spawn, after its launch's outcome and before its last write of the record | resent (the mark is kept to that write) | settles: `stop {E}`, then the launch's; the home is stopped |
| during a spawn's rollback, between its record and its receipt | unsettled: the launch still marked, the record already planned (not compared) | settles |
| during a spawn, before its record (while the provider's `check` is asked, or its hooks run) | not a home of the table yet: a receipt, where there is one, says planned, and the record is the one its files were composed with. A read answers that it is being spawned (`E_SESSION_UNAVAILABLE`), never that its records disagree | as for any spawn that ended before its record: the kernel has no verb for it yet (not this change's) |
| during a spawn, between the planned record and its last receipt | planned (the receipt was written before the record) | acts on it |
| during a resume of a home stopped with the host, after its notice | stopped with the host; its session may run again | the sweep sends the notice again; a stop or a start asks `stop {E}` |
| during that resume, after `stoppedAt` was cleared | running, with the host's stop receipt left | acts on a running home; a later loss of that start is a loss like any other, counted (a stop receipt says the host's stop only beside a receipt that says stopped), and a later stop removes that receipt before it records its own |

**An input in flight across a state change.** An input holds no claim and a
provider restarts a session on it, so the kernel checks after the send, with
one read of the home, whatever the provider answered (a refusal included):

| What the read says | What happened | What the kernel does |
|---|---|---|
| running, the same `startId` and endpoint | nothing | answers the provider's answer |
| stopped, or no session recorded | a stop landed, or a retire is waiting for this input (below) | `stop {E}` again; `E_SESSION_NOT_RUNNING`, not delivered |
| unsettled | a start is launching | `stop {E}` again; `E_SESSION_NOT_RUNNING`, not delivered |
| running, another `startId`, another endpoint | a restart landed | `stop {E}` again (the old one); `E_SESSION_NOT_RUNNING` |
| running, another `startId`, the same endpoint | a restart landed, and the provider reused the locator, which it must not (below) | nothing is stopped (that locator is the new session's); `E_SESSION_NOT_RUNNING`. The provider may have delivered the input to the new session all the same: the mail stays unread and is presented again, a duplicate, never a loss |

Since every stop drains (the stop rule), a stop's and a restart's own stop
wait for the input, which then reads the home *stopped*: the two rows
"running, another `startId`" are reached only by an input that outlasted the
drain's wait: its provider call is ended there, and its kernel, still
running, reads the home after the restart recorded its launch.

The same read before the send refuses without sending. A start of a lost
home stops the session at `E` after its mark (step 4), which covers the
input that finished before the mark: its provider call had ended by then, so
the session it restarted at `E` is stopped before the new one is launched,
and an input that reads the home after the mark stops it itself (the row
"unsettled").

A provider that hands a launch an endpoint it used before for the home
breaks the rule below. In the rows "stopped" and "unsettled" the `stop {E}`
then addresses whatever session holds that locator by then, which can be the
new one: the home is recorded running, its session is gone, it reads lost,
and the next input resumes it.

**The drain, and an input in flight.** An input holds no claim, so one can
be on its way when a stop, a start or a retire writes its fence. After a
stop or a restart the input itself could still ask the provider to stop
again (the table above); after a retire it could not: the home, and the
provider's commands with it, are gone; and an input whose kernel is killed
asks for nothing. So an input records that it is in flight, outside the
home, before its read of the home and until its answer, and **every stop
drains before it asks the provider**: it waits for the inputs in flight to
end, at most an input's timeout and a margin; one whose kernel is gone, or
dies meanwhile, is ended at once (below); one still in flight at the bound
is ended too (a retire then says so, naming the input's process).

**A provider's command outlives the kernel that ran it.** The kernel runs
every command of a provider in a process group of its own. A kernel that is
killed while it waits for one leaves that command running: a launch that
creates its session later, an input that restarts one, a stop that stops a
session resumed since. So a launch, an input and EVERY stop the kernel sends
(one function sends them all: a verb's, a spawn's rollback, an input's own
after a crossing) are recorded while they run (the table at the top: the kernel that made the
call, and the group its command runs in, written by the group's leader
before the provider runs), and the record is removed when the call returns.

A record whose kernel is gone is a call that may still act. The kernel
**ends** it: the group is killed (SIGKILL) and seen empty. A call whose
group had not recorded itself yet is made void: the kernel creates the
group's file itself, removes the call's record, then that file (both the
leader and the kernel publish that file whole, by an exclusive link from a
file of their own, so neither ever finds it half written); a leader
that comes late finds the file, or finds its call's record gone, and runs
nothing. A group that cannot be ended (its leader is gone and members are
left, or they survive) refuses the verb: `E_SESSION_STOP_FAILED` for a stop,
and an unsettled home stays unsettled.

Such calls are ended **before a provider's stop is relied on** (the drain),
and **before a launch, an input or a resume's notice is sent** (a stop left
behind would run late and stop what they start).

One window stays: a request the provider's own server had accepted before
the group was killed can complete moments later. The provider's `stop`,
which the kernel sends after the group is gone, is what covers it.

**Resume count.** Taken under its own lock, before the provider's `input`,
and given back only when the provider itself refused the input.

## What a provider must do for this to hold

- `stop` is idempotent, and with `endpoint: null` stops whatever session
  rooted at the home was created at or after `launchSent`.
- `launch` either answers an endpoint for a session it started, or refuses
  having started nothing. **The endpoint it answers differs from every
  endpoint it answered before for that home**: an endpoint names one session,
  never a place that a later session takes over.
- `input` answers `submitted: true` only when it dispatched the input.
- A command runs its own helpers inside the process group the kernel runs
  it in, and never detaches them: ending the group ends everything the
  command would still do on this host. Its `stop` looks at what is there
  when it is asked, after that group is gone.
